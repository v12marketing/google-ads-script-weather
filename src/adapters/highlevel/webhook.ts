import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { HighLevelEvent } from './types.js';

// Two sources reach POST /webhooks/highlevel/<secret>:
//  (a) Marketplace app webhooks: `InboundMessage` events, signed with x-ghl-signature.
//  (b) Workflow "Webhook" actions: HighLevel's standard contact payload plus the
//      CUSTOM DATA below. These are unsigned; the secret URL path is the check.

// Custom Data keys staff configure on each workflow's Webhook action (key = value).
//  - "Customer Replied" (Reply Channel SMS or Email):
//      hdc_event=inbound_message, contact_id, claim_number, message_body,
//      message_type, and optionally message_id.
//  - "Documents & Contracts", Status = Completed, Template = Settlement:
//      hdc_event=document_signed, contact_id, claim_number.
//  - Same trigger with Status = Declined:
//      hdc_event=document_declined, contact_id, claim_number.
// message_type may also be typed literally (SMS / Email) when a workflow filters
// on one reply channel.
export const HIGHLEVEL_WORKFLOW_CUSTOM_DATA = {
  hdc_event: 'inbound_message | document_signed | document_declined',
  contact_id: '{{contact.id}}',
  claim_number: '{{contact.claim_number}}',
  message_body: '{{message.body}}',
  message_type: '{{message.type}}',
  message_id: '{{message.id}}', // optional; used to dedupe retries
} as const;

const HDC_EVENTS = ['inbound_message', 'document_signed', 'document_declined'] as const;
type HdcEvent = (typeof HDC_EVENTS)[number];

// HighLevel ids are short alphanumeric strings; anything else is ignored rather
// than ending up in an API path.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLAIM_NUMBER_RE = /^[A-Za-z0-9-]{1,40}$/;
const MAX_BODY_CHARS = 20_000;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// A merge tag HighLevel left unrendered, e.g. "{{contact.claim_number}}".
const isMergeTag = (s: string): boolean => /^\{\{\s*[\w.]+\s*\}\}$/.test(s);

// A string value, or null when empty or an unrendered merge tag.
function text(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && !isMergeTag(t) ? t : null;
}

function id(v: unknown): string | null {
  const t = text(v);
  return t && ID_RE.test(t) ? t : null;
}

function claimNumber(v: unknown): string | null {
  const t = text(v);
  return t && CLAIM_NUMBER_RE.test(t) ? t.toUpperCase() : null;
}

// SMS vs Email; every other channel (calls, FB, IG, live chat, ...) is ignored.
// Accepts webhook names (SMS, Email), API enum names (TYPE_SMS) and the numeric
// message type codes (2 = SMS, 3 = Email).
export function normaliseChannel(v: unknown): 'sms' | 'email' | null {
  const t = text(v)?.toLowerCase().replace(/^type_/, '');
  if (t === 'sms' || t === '2') return 'sms';
  if (t === 'email' || t === '3') return 'email';
  return null;
}

export function parseHighLevelWebhook(body: unknown): HighLevelEvent | null {
  if (!isObj(body)) return null;
  const custom = isObj(body.customData) ? body.customData : {};
  // Custom data arrives under customData or flattened into the top level.
  const get = (k: string): unknown => custom[k] ?? body[k];

  const hdc = text(get('hdc_event'))?.toLowerCase();
  if (hdc) return HDC_EVENTS.includes(hdc as HdcEvent) ? parseWorkflow(hdc as HdcEvent, body, get) : null;
  if (body.type === 'InboundMessage') return parseInboundMessage(body);
  return null;
}

function parseInboundMessage(b: Obj): HighLevelEvent | null {
  if (typeof b.direction === 'string' && b.direction.toLowerCase() !== 'inbound') return null;
  const channel = normaliseChannel(b.messageType);
  const contactId = id(b.contactId);
  if (!channel || !contactId) return null;
  const body = messageText(b.body, channel);
  if (!body) return null;
  return {
    kind: 'inbound_message',
    contactId,
    channel,
    body,
    messageId: id(b.messageId),
    subject: channel === 'email' ? text(b.subject)?.slice(0, 500) ?? null : null,
  };
}

function parseWorkflow(kind: HdcEvent, b: Obj, get: (k: string) => unknown): HighLevelEvent | null {
  // contact_id is also a standard field of the workflow payload.
  const contactId = id(get('contact_id')) ?? id(get('contactId'));
  const claim = claimNumber(get('claim_number'));
  if (kind === 'document_signed') {
    return { kind, contactId, documentId: id(get('document_id')), claimNumber: claim };
  }
  if (kind === 'document_declined') return { kind, contactId, claimNumber: claim };

  // The standard payload's `message` object is the fallback for unset custom data.
  const message = isObj(b.message) ? b.message : {};
  const channel = normaliseChannel(get('message_type')) ?? normaliseChannel(message.type ?? message.messageType);
  if (!contactId || !channel) return null;
  const body = messageText(get('message_body'), channel) ?? messageText(message.body, channel);
  if (!body) return null;
  return {
    kind: 'inbound_message',
    contactId,
    channel,
    body,
    messageId: id(get('message_id')) ?? id(message.id),
    subject: channel === 'email' ? text(message.subject)?.slice(0, 500) ?? null : null,
  };
}

function messageText(v: unknown, channel: 'sms' | 'email'): string | null {
  if (typeof v !== 'string' || isMergeTag(v.trim())) return null;
  const t = (channel === 'email' ? emailToText(v) : v.replace(/\r\n?/g, '\n')).trim();
  return t ? t.slice(0, MAX_BODY_CHARS) : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Inbound email bodies are HTML with the quoted thread below the reply. Keeps
// just the new text; falls back to the whole message if that leaves nothing.
export function emailToText(input: string): string {
  const looksHtml = /<\/?(p|div|br|span|html|body|blockquote|table|a|b|i|strong|em)\b[^>]*>/i.test(input);
  let s = input.replace(/\r\n?/g, '\n');
  if (looksHtml) {
    s = s
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Gmail / Apple / Outlook quote containers: drop from there to the end.
      .replace(/<div[^>]*class="[^"]*(gmail_quote|gmail_extra|yahoo_quoted)[^"]*"[\s\S]*$/i, '')
      .replace(/<div[^>]*id="(divRplyFwdMsg|appendonsend)"[\s\S]*$/i, '')
      .replace(/<blockquote\b[\s\S]*$/i, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
  }
  const full = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = full.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^On .{4,200}wrote:$/i.test(line) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) break;
    if (/^From:\s/i.test(line) && lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date):\s/i.test(l.trim()))) break;
    if (line.startsWith('>')) continue;
    out.push(lines[i]!);
  }
  const reply = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return reply || full;
}

// ---- signature ----

// Raw 32-byte Ed25519 keys get this SPKI DER prefix to become a KeyObject.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const keyCache = new Map<string, KeyObject | null>();

function parsePublicKey(publicKey: string): KeyObject | null {
  if (keyCache.has(publicKey)) return keyCache.get(publicKey)!;
  let key: KeyObject | null = null;
  try {
    const k = publicKey.trim();
    if (k.includes('-----BEGIN')) {
      key = createPublicKey(k.replace(/\\n/g, '\n'));
    } else {
      let der = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, 'hex') : Buffer.from(k, 'base64');
      if (der.length === 32) der = Buffer.concat([ED25519_SPKI_PREFIX, der]);
      key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    if (key.asymmetricKeyType !== 'ed25519') key = null;
  } catch {
    key = null;
  }
  keyCache.set(publicKey, key);
  return key;
}

// Verifies HighLevel's Ed25519 x-ghl-signature (base64) over the exact raw body.
// publicKey is SPKI PEM, base64 SPKI DER, or a raw 32-byte key (base64/hex).
export function verifyHighLevelSignature(rawBody: string | Buffer, signature: string | undefined, publicKey: string): boolean {
  if (!signature || !signature.trim()) return false;
  const key = parsePublicKey(publicKey);
  if (!key) return false;
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody, key, sig);
  } catch {
    return false;
  }
}
