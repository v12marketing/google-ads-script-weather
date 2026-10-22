import type { AppConfig } from '../../config.js';
import type { ContactInput, HighLevelApi, SendEmailInput, SendSmsInput, SettlementRequest, SignedDocumentCheck } from './types.js';

// Real HighLevel (LeadConnector) API v2 client, authenticated with a sub-account
// Private Integration Token. Shapes follow docs/research/highlevel-*.md.

export const HIGHLEVEL_BASE_URL = 'https://services.leadconnectorhq.com';
// Every /conversations/* operation declares exactly this Version; contacts,
// locations and proposals use 2021-07-28 (config.HIGHLEVEL_API_VERSION).
export const CONVERSATIONS_API_VERSION = '2021-04-15';
const DEFAULT_TIMEOUT_MS = 20_000;
const DOCUMENT_PAGE_SIZE = 50;
const MAX_DOCUMENT_PAGES = 100;

// Contact custom fields the integration writes and the settlement template merges
// ({{contact.claim_number}} etc.). scripts/highlevel-setup.ts creates them as TEXT.
export const CONTACT_CUSTOM_FIELDS = [
  { key: 'claim_number', name: 'Claim Number' },
  { key: 'settlement_amount', name: 'Settlement Amount' },
  { key: 'portal_url', name: 'Portal URL' },
] as const;

export type HighLevelConfig = Pick<
  AppConfig,
  | 'HIGHLEVEL_API_TOKEN'
  | 'HIGHLEVEL_LOCATION_ID'
  | 'HIGHLEVEL_API_VERSION'
  | 'HIGHLEVEL_EMAIL_FROM'
  | 'HIGHLEVEL_EMAIL_FROM_NAME'
  | 'HIGHLEVEL_SETTLEMENT_TEMPLATE_ID'
  | 'HIGHLEVEL_USER_ID'
>;

export interface HighLevelClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export class HighLevelApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly method: string,
    readonly path: string,
    // HighLevel's own error text (validation messages etc.), scrubbed.
    readonly detail: string,
  ) {
    super(message);
    this.name = 'HighLevelApiError';
  }

  // Network failures, timeouts, 429 and 5xx can succeed later; other 4xx need a fix.
  get retryable(): boolean {
    return this.status === null || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface HighLevelCustomField {
  id: string;
  name?: string;
  fieldKey?: string;
  dataType?: string;
  model?: string;
}

export interface HighLevelTemplate {
  _id?: string;
  id?: string;
  name?: string;
  type?: string;
  deleted?: boolean;
  updatedAt?: string;
}

interface DocumentRecipient {
  id?: string;
  role?: string;
  hasCompleted?: boolean;
  signedDate?: string | number | null;
  ip?: string | null;
}

interface DocumentLink {
  documentId?: string;
  referenceId?: string;
}

interface DocumentDto {
  _id?: string;
  documentId?: string;
  name?: string;
  deleted?: boolean;
  isExpired?: boolean;
  status?: string | string[];
  recipients?: DocumentRecipient[];
  links?: DocumentLink[];
}

type Query = Record<string, string | number | undefined>;

export class HighLevelClient implements HighLevelApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private fieldsPromise: Promise<HighLevelCustomField[]> | null = null;
  // Set once HighLevel rejects a message without `status` (see sendMessage).
  private messageStatusRequired = false;

  constructor(
    readonly config: HighLevelConfig,
    private readonly opts: HighLevelClientOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? HIGHLEVEL_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get locationId(): string {
    return this.config.HIGHLEVEL_LOCATION_ID;
  }

  // ---- contacts ----

  async upsertContact(input: ContactInput): Promise<string> {
    const email = input.email?.trim() || null;
    const phone = toE164(input.phone);
    if (!email && !phone) throw new Error('HighLevel upsertContact: the claim has no usable email or phone');
    const lastName = lastNameOf(input.name, input.firstName);
    // No tags here: tags on upsert replace every tag on the contact, so they go
    // through the add-tags endpoint below. dnd/dndSettings are never sent.
    const body: Record<string, unknown> = {
      locationId: this.locationId,
      name: input.name,
      firstName: input.firstName,
      ...(lastName ? { lastName } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      source: 'HomeDeliveryClaims.com',
    };
    if (input.customFields && Object.keys(input.customFields).length > 0) {
      body.customFields = await this.customFieldValues(input.customFields);
    }
    const res = await this.request<{ contact?: { id?: string } }>('POST', '/contacts/upsert', { body });
    const id = res.contact?.id;
    if (!id) throw new Error('HighLevel POST /contacts/upsert returned no contact id');
    if (input.tags?.length) await this.addTags(id, input.tags);
    return id;
  }

  async updateContactFields(contactId: string, customFields: Record<string, string>): Promise<void> {
    if (Object.keys(customFields).length === 0) return;
    // customFields only: a `tags` key on PUT would overwrite all of the contact's tags.
    await this.request('PUT', `/contacts/${seg(contactId)}`, { body: { customFields: await this.customFieldValues(customFields) } });
  }

  async addTags(contactId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    await this.request('POST', `/contacts/${seg(contactId)}/tags`, { body: { tags } });
  }

  async removeTags(contactId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    await this.request('DELETE', `/contacts/${seg(contactId)}/tags`, { body: { tags } });
  }

  // ---- messages ----

  async sendEmail(input: SendEmailInput): Promise<{ messageId: string | null }> {
    return this.sendMessage({
      type: 'Email',
      contactId: input.contactId,
      subject: input.subject,
      html: input.html,
      emailFrom: formatFrom(this.config.HIGHLEVEL_EMAIL_FROM_NAME, this.config.HIGHLEVEL_EMAIL_FROM),
    });
  }

  async sendSms(input: SendSmsInput): Promise<{ messageId: string | null }> {
    return this.sendMessage({ type: 'SMS', contactId: input.contactId, message: input.message });
  }

  // The 2026-05 spec sync marked `subType` and `status` required, while earlier
  // specs required only type + contactId. Send the minimal body; if HighLevel
  // rejects it for a missing `status`, resend once with status 'pending' and keep
  // doing so. A 400 can't have sent anything, so the resend can't duplicate.
  private async sendMessage(body: Record<string, unknown>): Promise<{ messageId: string | null }> {
    const send = (b: Record<string, unknown>) =>
      this.request<{ messageId?: string }>('POST', '/conversations/messages', { body: b, version: CONVERSATIONS_API_VERSION });
    let res: { messageId?: string };
    try {
      res = await send(this.messageStatusRequired ? { ...body, status: 'pending' } : body);
    } catch (err) {
      if (!(err instanceof HighLevelApiError) || err.status !== 400) throw err;
      if (/\bsubType\b/i.test(err.detail)) {
        throw new HighLevelApiError(
          `${err.message} (HighLevel now requires subType on POST /conversations/messages; its values are undocumented, ask HighLevel support)`,
          err.status, err.method, err.path, err.detail,
        );
      }
      if (this.messageStatusRequired || !/\bstatus\s+(must|should)\b/i.test(err.detail)) throw err;
      this.messageStatusRequired = true;
      res = await send({ ...body, status: 'pending' });
    }
    return { messageId: typeof res.messageId === 'string' && res.messageId ? res.messageId : null };
  }

  // ---- settlement e-signature ----

  async requestSettlementSignature(req: SettlementRequest): Promise<{ documentId: string | null; referenceId: string | null }> {
    if (!Number.isFinite(req.settlementAmount) || req.settlementAmount <= 0) {
      throw new Error(`HighLevel settlement for ${req.claimNumber}: invalid settlement amount`);
    }
    const fields = {
      claim_number: req.claimNumber,
      settlement_amount: formatUsd(req.settlementAmount),
      portal_url: req.portalUrl,
    };
    await this.updateContactFields(req.contactId, fields);
    // The document merges these fields from the contact at send time, so make sure
    // they stuck before sending a legal document with a blank or stale amount.
    await this.assertContactFields(req.contactId, fields);

    const res = await this.request<{ success?: boolean; links?: Array<DocumentLink & { recipientId?: string; recipientCategory?: string; entityName?: string }> }>(
      'POST',
      '/proposals/templates/send',
      {
        body: {
          templateId: this.config.HIGHLEVEL_SETTLEMENT_TEMPLATE_ID,
          userId: this.config.HIGHLEVEL_USER_ID,
          locationId: this.locationId,
          contactId: req.contactId,
          sendDocument: true,
        },
      },
    );
    if (res.success === false) throw new Error('HighLevel POST /proposals/templates/send returned success=false');
    const links = res.links ?? [];
    const link =
      links.find((l) => l.recipientId === req.contactId && l.recipientCategory === 'recipient') ??
      links.find((l) => l.recipientId === req.contactId) ??
      links.find((l) => l.entityName === 'contacts' && l.recipientCategory === 'recipient') ??
      links[0];
    return { documentId: str(link?.documentId), referenceId: str(link?.referenceId) };
  }

  private async assertContactFields(contactId: string, expected: Record<string, string>): Promise<void> {
    const ids = await this.resolveFieldIds(Object.keys(expected));
    const res = await this.request<{ contact?: { customFields?: Array<{ id?: string; value?: unknown }> } }>(
      'GET',
      `/contacts/${seg(contactId)}`,
    );
    const actual = new Map((res.contact?.customFields ?? []).map((f) => [f.id, f.value]));
    // Names only: values include the portal link, which must not reach logs.
    const wrong = Object.keys(expected).filter((k) => String(actual.get(ids.get(k)) ?? '') !== expected[k]);
    if (wrong.length > 0) {
      throw new Error(`HighLevel contact ${contactId}: custom field(s) ${wrong.join(', ')} did not save; settlement not sent`);
    }
  }

  // Signed only when the document is completed, not deleted or expired, every signer
  // has hasCompleted + a valid signedDate, and this contact is one of them. Staff can
  // "Mark as Completed" in the UI without signatures, so status alone proves nothing.
  async verifySignedDocument(
    ref: { documentId: string | null; referenceId: string | null },
    contactId: string,
  ): Promise<SignedDocumentCheck> {
    const ids = new Set([ref.documentId, ref.referenceId].filter((v): v is string => !!v));
    if (ids.size === 0) return notSigned('not_found');
    // There is no get-by-id and no contact filter, so scan the location's list.
    const doc =
      (await this.findDocument(ids, 'completed')) ?? (await this.findDocument(ids, 'draft,sent,viewed,accepted'));
    if (!doc) return notSigned('not_found');
    return checkDocument(doc, contactId);
  }

  private async findDocument(ids: Set<string>, status: string): Promise<DocumentDto | null> {
    let skip = 0;
    for (let page = 0; page < MAX_DOCUMENT_PAGES; page++) {
      const res = await this.request<{ documents?: DocumentDto[]; total?: number | string }>('GET', '/proposals/document', {
        query: { locationId: this.locationId, status, limit: DOCUMENT_PAGE_SIZE, skip },
      });
      const docs = Array.isArray(res.documents) ? res.documents : [];
      const hit = docs.find((d) => documentMatches(d, ids));
      if (hit) return hit;
      if (docs.length === 0) return null;
      skip += docs.length;
      const total = Number(res.total);
      if (Number.isFinite(total) ? skip >= total : docs.length < DOCUMENT_PAGE_SIZE) return null;
    }
    return null;
  }

  // ---- custom fields & setup helpers (also used by scripts/highlevel-setup.ts) ----

  async listCustomFields(): Promise<HighLevelCustomField[]> {
    const res = await this.request<{ customFields?: HighLevelCustomField[] }>(
      'GET',
      `/locations/${seg(this.locationId)}/customFields`,
      { query: { model: 'contact' } },
    );
    return (res.customFields ?? []).filter((f) => f && typeof f.id === 'string' && (!f.model || f.model === 'contact'));
  }

  async createCustomField(name: string, dataType = 'TEXT'): Promise<HighLevelCustomField> {
    const res = await this.request<{ customField?: HighLevelCustomField }>('POST', `/locations/${seg(this.locationId)}/customFields`, {
      body: { name, dataType, model: 'contact' },
    });
    if (!res.customField?.id) throw new Error(`HighLevel did not return the created custom field "${name}"`);
    this.fieldsPromise = null;
    return res.customField;
  }

  async getLocation(): Promise<{ id?: string; name?: string }> {
    const res = await this.request<{ location?: { id?: string; name?: string } }>('GET', `/locations/${seg(this.locationId)}`);
    return res.location ?? {};
  }

  async listTemplates(): Promise<HighLevelTemplate[]> {
    const all: HighLevelTemplate[] = [];
    for (let skip = 0, page = 0; page < MAX_DOCUMENT_PAGES; page++) {
      const res = await this.request<{ data?: HighLevelTemplate[]; total?: number | string }>('GET', '/proposals/templates', {
        query: { locationId: this.locationId, limit: DOCUMENT_PAGE_SIZE, skip },
      });
      const items = Array.isArray(res.data) ? res.data : [];
      all.push(...items);
      skip += items.length;
      const total = Number(res.total);
      if (items.length === 0 || (Number.isFinite(total) ? skip >= total : items.length < DOCUMENT_PAGE_SIZE)) break;
    }
    return all;
  }

  async listUsers(): Promise<Array<{ id?: string; name?: string; firstName?: string; lastName?: string }>> {
    const res = await this.request<{ users?: Array<{ id?: string; name?: string; firstName?: string; lastName?: string }> }>('GET', '/users/', {
      query: { locationId: this.locationId },
    });
    return res.users ?? [];
  }

  // Our key (claim_number) -> HighLevel field id, matched by fieldKey
  // 'contact.claim_number' or by a name that normalises to the key ("Claim Number").
  private async resolveFieldIds(keys: string[]): Promise<Map<string, string>> {
    const match = (fields: HighLevelCustomField[]) => {
      const out = new Map<string, string>();
      for (const key of keys) {
        const f = findContactField(fields, key);
        if (f) out.set(key, f.id);
      }
      return out;
    };
    let ids = match(await this.loadFields());
    if (ids.size < keys.length) {
      // Staff may have created the field since we cached the list.
      this.fieldsPromise = null;
      ids = match(await this.loadFields());
    }
    const missing = keys.filter((k) => !ids.has(k));
    if (missing.length > 0) {
      const names = missing.map((k) => `"${k}" (create a TEXT contact field named "${CONTACT_CUSTOM_FIELDS.find((f) => f.key === k)?.name ?? k}", key contact.${k})`);
      throw new Error(
        `HighLevel contact custom field missing: ${names.join(', ')}. Run "npx tsx scripts/highlevel-setup.ts fields" to create them.`,
      );
    }
    return ids;
  }

  private loadFields(): Promise<HighLevelCustomField[]> {
    if (!this.fieldsPromise) {
      this.fieldsPromise = this.listCustomFields();
      this.fieldsPromise.catch(() => (this.fieldsPromise = null));
    }
    return this.fieldsPromise;
  }

  private async customFieldValues(values: Record<string, string>): Promise<Array<{ id: string; field_value: string }>> {
    const ids = await this.resolveFieldIds(Object.keys(values));
    return Object.entries(values).map(([k, v]) => ({ id: ids.get(k)!, field_value: v }));
  }

  // ---- transport ----

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    o: { query?: Query; body?: unknown; version?: string } = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.HIGHLEVEL_API_TOKEN}`,
      Version: o.version ?? this.config.HIGHLEVEL_API_VERSION,
      Accept: 'application/json',
    };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `timed out after ${this.timeoutMs / 1000}s` : `failed: ${e?.message ?? String(err)}`;
      throw new HighLevelApiError(`HighLevel ${method} ${path} ${why}`, null, method, path, '');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError(res, method, path, text);
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HighLevelApiError(`HighLevel ${method} ${path} returned invalid JSON (HTTP ${res.status})`, res.status, method, path, '');
    }
  }
}

function httpError(res: Response, method: string, path: string, text: string): HighLevelApiError {
  let detail = text;
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = Array.isArray(j.message) ? j.message.join('; ') : j.message ?? j.error;
    if (typeof m === 'string' && m) detail = m;
  } catch {
    // not JSON; keep the raw text
  }
  detail = scrub(detail).slice(0, 500);
  const base = `HighLevel ${method} ${path} failed with HTTP ${res.status}`;
  let hint = '';
  if (res.status === 429) {
    const interval = res.headers.get('x-ratelimit-interval-milliseconds');
    const daily = res.headers.get('x-ratelimit-daily-remaining');
    hint = ` (rate limited${daily === '0' ? ', daily limit used up' : ''}${interval ? `, window ${interval}ms` : ''}; will retry with backoff)`;
  } else if (res.status === 401 || res.status === 403) {
    hint = ' (check HIGHLEVEL_API_TOKEN and that the Private Integration has the needed scopes)';
  } else if (res.status >= 500) {
    hint = ' (HighLevel server error; will retry)';
  }
  return new HighLevelApiError(`${base}${hint}${detail ? `: ${detail}` : ''}`, res.status, method, path, detail);
}

// Portal links carry the claim's access token; never let one into an error message.
function scrub(s: string): string {
  return s.replace(/\/c\/[A-Za-z0-9_-]+/g, '/c/[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function seg(id: string): string {
  return encodeURIComponent(id);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// Our key -> field: fieldKey 'contact.<key>' first, else a name that normalises to
// the key ("Claim Number" -> claim_number).
export function findContactField(fields: HighLevelCustomField[], key: string): HighLevelCustomField | undefined {
  const fieldKey = (k: string | undefined) => (k ?? '').replace(/[{}\s]/g, '').toLowerCase();
  const name = (n: string | undefined) => (n ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return fields.find((f) => fieldKey(f.fieldKey) === `contact.${key}`) ?? fields.find((f) => name(f.name) === key);
}

function lastNameOf(name: string, firstName: string): string | null {
  const n = name.trim();
  const f = firstName.trim();
  if (!f || !n.toLowerCase().startsWith(f.toLowerCase())) return null;
  return n.slice(f.length).trim() || null;
}

// E.164 for HighLevel; bare 10-digit numbers are taken as US/Canada.
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (phone.trim().startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

// "Home Delivery Claims <claims@example.com>"; quotes the name when it has specials.
export function formatFrom(name: string, address: string): string {
  if (address.includes('<')) return address.trim();
  const clean = name.replace(/[\r\n<>"\\]/g, '').trim();
  if (!clean) return address.trim();
  return `${/[(),.:;@[\]]/.test(clean) ? `"${clean}"` : clean} <${address.trim()}>`;
}

function documentMatches(d: DocumentDto, ids: Set<string>): boolean {
  if ((d._id && ids.has(d._id)) || (d.documentId && ids.has(d.documentId))) return true;
  return (d.links ?? []).some((l) => (l.documentId && ids.has(l.documentId)) || (l.referenceId && ids.has(l.referenceId)));
}

function validDate(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
}

function notSigned(reason: string, documentName: string | null = null): SignedDocumentCheck {
  return { signed: false, reason, signedAt: null, signerIp: null, documentName };
}

function checkDocument(d: DocumentDto, contactId: string): SignedDocumentCheck {
  const name = d.name ?? null;
  if (d.deleted) return notSigned('deleted', name);
  if (d.isExpired) return notSigned('expired', name);
  // status is typed as an array in the spec but arrives as a string in examples.
  const statuses = (Array.isArray(d.status) ? d.status : [d.status]).map((s) => String(s ?? '').toLowerCase());
  if (!statuses.includes('completed')) return notSigned('not_completed', name);
  const recipients = Array.isArray(d.recipients) ? d.recipients : [];
  const claimant = recipients.find((r) => r.id === contactId);
  if (!claimant) return notSigned('wrong_signer', name);
  // role is 'signer' for every recipient in practice; treat a missing role as a signer too.
  const signers = recipients.filter((r) => !r.role || r.role === 'signer');
  if (!signers.includes(claimant)) signers.push(claimant);
  if (!signers.every((r) => r.hasCompleted === true && validDate(r.signedDate))) return notSigned('missing_signatures', name);
  return {
    signed: true,
    reason: null,
    signedAt: validDate(claimant.signedDate),
    signerIp: typeof claimant.ip === 'string' && claimant.ip ? claimant.ip : null,
    documentName: name,
  };
}
