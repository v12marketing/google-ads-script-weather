import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MondayEvent } from './types.js';

export type ParsedMondayWebhook = { challenge: string } | { event: MondayEvent } | { ignore: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// Monday ids arrive as JSON numbers (sometimes numeric strings); normalise to strings.
function idOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return v;
  return null;
}

// Column values in payloads are objects, but tolerate a JSON string.
function objOf(v: unknown): Obj | null {
  if (isObj(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return isObj(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function labelText(value: unknown): string | null {
  const label = objOf(value)?.label;
  const text = isObj(label) ? str(label.text) : null;
  return text ? text : null; // Monday's blank label has text ''
}

// Plain text from an update's HTML body (used when no text_body is available).
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d{1,7});/g, (m, n: string) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// `event.type` differs from the subscription name: create_item delivers
// create_pulse and every column subscription delivers update_column_value.
const ITEM_CREATED = new Set(['create_pulse', 'create_item']);
const COLUMN_CHANGED = new Set([
  'update_column_value',
  'change_column_value',
  'change_status_column_value',
  'change_specific_column_value',
]);

// Turns Monday's raw webhook JSON into a normalised event (or the challenge handshake).
export function parseMondayWebhook(body: unknown): ParsedMondayWebhook {
  if (!isObj(body)) return { ignore: 'body is not a JSON object' };
  if (typeof body.challenge === 'string') return { challenge: body.challenge };

  const ev = body.event;
  if (!isObj(ev)) return { ignore: 'no event in payload' };
  const type = str(ev.type) ?? '';
  // We only subscribe to item-level events; subitem events carry the parent's id.
  if (ev.parentItemId != null) return { ignore: `subitem event ${type}` };

  const boardId = idOf(ev.boardId);
  const itemId = idOf(ev.pulseId);
  if (!boardId || !itemId) return { ignore: `event ${type || '(no type)'} without boardId/pulseId` };
  const triggerUuid = str(ev.triggerUuid);

  if (ITEM_CREATED.has(type)) return { event: { kind: 'item_created', boardId, itemId, triggerUuid } };

  if (COLUMN_CHANGED.has(type)) {
    const columnId = str(ev.columnId);
    if (!columnId) return { ignore: `${type} without columnId` };
    const isStatus =
      type === 'change_status_column_value' ||
      ev.columnType === 'color' || // the API's legacy name for status columns
      ev.columnType === 'status' ||
      isObj(objOf(ev.value)?.label);
    if (isStatus) {
      return {
        event: {
          kind: 'status_changed',
          boardId,
          itemId,
          columnId,
          label: labelText(ev.value),
          previousLabel: labelText(ev.previousValue),
          triggerUuid,
        },
      };
    }
    return { event: { kind: 'column_changed', boardId, itemId, columnId, triggerUuid } };
  }

  if (type === 'create_update') {
    // Whether replies fire create_update is undocumented; if one carries a
    // replyId, that identifies the new post, so dedupe on it.
    const updateId = idOf(ev.replyId) ?? idOf(ev.updateId);
    if (!updateId) return { ignore: 'create_update without updateId' };
    const html = str(ev.body);
    const textBody = str(ev.textBody) || (html ? htmlToText(html) : '');
    return {
      event: { kind: 'update_created', boardId, itemId, updateId, textBody, creatorId: idOf(ev.userId), triggerUuid },
    };
  }

  return { ignore: `unsupported event type ${type || '(none)'}` };
}

const CLOCK_SKEW_S = 30;

function decodeJsonPart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Verifies the Authorization header Monday sends when a signing secret is configured.
// Returns true when no secret is configured (the secret URL path is then the only check).
// Only webhooks created with an app (OAuth) token carry this HS256 JWT. It does not
// cover the body, and `aud` (the registered URL) is not checked because its exact
// format is undocumented.
export function verifyMondayAuthorization(authorization: string | undefined, signingSecret: string | undefined): boolean {
  if (!signingSecret) return true;
  if (!authorization) return false;
  const parts = authorization.trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  const [h, p, sig] = parts as [string, string, string];

  const header = decodeJsonPart(h);
  if (!isObj(header) || header.alg !== 'HS256') return false;
  const expected = createHmac('sha256', signingSecret).update(`${h}.${p}`).digest('base64url');
  if (!safeEqual(expected, sig)) return false;

  const claims = decodeJsonPart(p);
  if (!isObj(claims)) return false;
  const now = Date.now() / 1000;
  if (claims.exp !== undefined && (typeof claims.exp !== 'number' || now > claims.exp + CLOCK_SKEW_S)) return false;
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || now + CLOCK_SKEW_S < claims.nbf)) return false;
  return true;
}
