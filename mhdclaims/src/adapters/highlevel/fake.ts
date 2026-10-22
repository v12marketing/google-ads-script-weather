import type {
  ContactDetails,
  ContactIdentity,
  ContactInput,
  HighLevelApi,
  SendEmailInput,
  SendSmsInput,
  SentDocument,
  SettlementDocumentRef,
  SettlementRequest,
  SignedDocumentCheck,
} from './types.js';

// Records everything sent through HighLevel so tests can assert on it.
export class FakeHighLevel implements HighLevelApi {
  contacts = new Map<string, ContactInput & { id: string; tags: string[]; customFields: Record<string, string> }>();
  // The location's duplicate-matching sequence (Settings → Allow Duplicate Contact).
  matchOrder: Array<'email' | 'phone'> = ['email', 'phone'];
  emails: SendEmailInput[] = [];
  sms: SendSmsInput[] = [];
  settlementRequests: SettlementRequest[] = [];
  // documentId -> state; tests flip `signed` to simulate the claimant signing.
  // Deleting an entry simulates a document the list no longer returns.
  documents = new Map<string, { contactId: string; signed: boolean; signedAt: string | null; createdAt: string; signUrl: string | null }>();
  calls: Array<{ method: string; args: unknown[] }> = [];
  failNext = 0;
  // The next N settlement sends create the document but then fail, as a timeout
  // or 5xx after HighLevel sent it would.
  failAfterSend = 0;
  // The next N settlement sends return no document ids.
  sendWithoutIds = 0;
  private nextId = 1;

  private maybeFail(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`FakeHighLevel: simulated failure in ${method}`);
    }
  }

  // HighLevel's default duplicate rule: an existing contact with the same email OR
  // phone is updated, and every field sent overwrites its value, so a phone match
  // takes on the new email. When the email and the phone match two different
  // contacts, the one matching the first field in matchOrder is updated and the
  // other field is ignored. Fields not sent (null) keep the contact's value.
  async upsertContact(input: ContactInput): Promise<ContactIdentity> {
    this.maybeFail('upsertContact', [input]);
    const all = [...this.contacts.values()];
    const byField = {
      email: input.email ? all.find((c) => c.email?.toLowerCase() === input.email!.toLowerCase()) : undefined,
      phone: input.phone ? all.find((c) => c.phone === input.phone) : undefined,
    };
    const first = this.matchOrder.find((f) => byField[f]);
    const c = first ? byField[first] : undefined;
    if (c) {
      const other = this.matchOrder.find((f) => f !== first)!;
      const ignored = byField[other] && byField[other] !== c ? other : null;
      Object.assign(c, {
        name: input.name,
        firstName: input.firstName,
        smsOptIn: input.smsOptIn,
        ...(input.email && ignored !== 'email' ? { email: input.email } : {}),
        ...(input.phone && ignored !== 'phone' ? { phone: input.phone } : {}),
        tags: [...new Set([...c.tags, ...(input.tags ?? [])])],
        customFields: { ...c.customFields, ...input.customFields },
      });
      return this.identity(c);
    }
    const id = `contact_${this.nextId++}`;
    const created = { ...input, id, tags: input.tags ?? [], customFields: input.customFields ?? {} };
    this.contacts.set(id, created);
    return this.identity(created);
  }

  async getContact(contactId: string): Promise<ContactIdentity | null> {
    this.maybeFail('getContact', [contactId]);
    const c = this.contacts.get(contactId);
    return c ? this.identity(c) : null;
  }

  async updateContact(contactId: string, details: ContactDetails): Promise<void> {
    this.maybeFail('updateContact', [contactId, details]);
    const c = this.contacts.get(contactId);
    if (!c) return;
    const { customFields, ...rest } = details;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) Object.assign(c, { [k]: v });
    if (customFields) Object.assign(c.customFields, customFields);
  }

  private identity(c: { id: string; email: string | null; phone: string | null }): ContactIdentity {
    return { id: c.id, email: c.email ?? null, phone: c.phone ?? null };
  }

  async updateContactFields(contactId: string, customFields: Record<string, string>): Promise<void> {
    this.maybeFail('updateContactFields', [contactId, customFields]);
    const c = this.contacts.get(contactId);
    if (c) Object.assign(c.customFields, customFields);
  }

  async addTags(contactId: string, tags: string[]): Promise<void> {
    this.maybeFail('addTags', [contactId, tags]);
    const c = this.contacts.get(contactId);
    if (c) c.tags = [...new Set([...c.tags, ...tags])];
  }

  async removeTags(contactId: string, tags: string[]): Promise<void> {
    this.maybeFail('removeTags', [contactId, tags]);
    const c = this.contacts.get(contactId);
    if (c) c.tags = c.tags.filter((t) => !tags.includes(t));
  }

  async sendEmail(input: SendEmailInput): Promise<{ messageId: string | null }> {
    this.maybeFail('sendEmail', [input]);
    this.emails.push(input);
    return { messageId: `msg_${this.nextId++}` };
  }

  async sendSms(input: SendSmsInput): Promise<{ messageId: string | null }> {
    this.maybeFail('sendSms', [input]);
    this.sms.push(input);
    return { messageId: `msg_${this.nextId++}` };
  }

  async requestSettlementSignature(req: SettlementRequest): Promise<SettlementDocumentRef> {
    this.maybeFail('requestSettlementSignature', [req]);
    this.settlementRequests.push(req);
    const documentId = `doc_${this.nextId++}`;
    this.documents.set(documentId, {
      contactId: req.contactId,
      signed: false,
      signedAt: null,
      createdAt: new Date().toISOString(),
      signUrl: `https://link.example.test/documents/${documentId}`,
    });
    if (this.failAfterSend > 0) {
      this.failAfterSend--;
      throw new Error('FakeHighLevel: simulated timeout after the document was sent');
    }
    if (this.sendWithoutIds > 0) {
      this.sendWithoutIds--;
      return { documentId: null, referenceId: null };
    }
    return { documentId, referenceId: `ref_${documentId}` };
  }

  async findSentDocuments(contactId: string, since: string, exclude: SettlementDocumentRef[] = []): Promise<SentDocument[]> {
    this.maybeFail('findSentDocuments', [contactId, since, exclude]);
    const known = new Set(exclude.flatMap((r) => [r.documentId, r.referenceId?.replace(/^ref_/, '')]));
    return [...this.documents.entries()]
      .filter(([id, d]) => d.contactId === contactId && !known.has(id) && d.createdAt >= since)
      .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt))
      .map(([id, d]) => ({ documentId: id, referenceId: `ref_${id}`, createdAt: d.createdAt, signUrl: d.signUrl }));
  }

  // Test helper: the claimant signs the most recent document sent to them.
  sign(documentId?: string): string {
    const id = documentId ?? [...this.documents.keys()].pop();
    const d = id ? this.documents.get(id) : undefined;
    if (!id || !d) throw new Error('FakeHighLevel: no document to sign');
    d.signed = true;
    d.signedAt = new Date().toISOString();
    return id;
  }

  async verifySignedDocument(ref: SettlementDocumentRef, contactId: string, opts: { sentAt?: string | null } = {}): Promise<SignedDocumentCheck> {
    this.maybeFail('verifySignedDocument', [ref, contactId, opts]);
    const id = ref.documentId ?? ref.referenceId?.replace(/^ref_/, '') ?? '';
    const d = this.documents.get(id);
    if (!d) return { signed: false, reason: 'not_found', signedAt: null, signerIp: null, documentName: null, signUrl: null };
    if (d.contactId !== contactId) return { signed: false, reason: 'wrong_signer', signedAt: null, signerIp: null, documentName: null, signUrl: null };
    if (!d.signed) return { signed: false, reason: 'not_completed', signedAt: null, signerIp: null, documentName: null, signUrl: d.signUrl };
    return { signed: true, reason: null, signedAt: d.signedAt, signerIp: '203.0.113.7', documentName: 'Settlement Agreement', signUrl: d.signUrl };
  }
}
