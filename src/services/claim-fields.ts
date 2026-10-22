import { createHash } from 'node:crypto';
import type { MondayColumnValue, MondayItem, MondayWriteOptions } from '../adapters/monday/types.js';
import type { BoardConfig } from '../board-config.js';
import type { CoreContext } from './contracts.js';

// Reads claim fields out of a Monday item's column values. Monday returns both a
// rendered `text` and a raw JSON `value`; either can be missing depending on the
// column type and how the item was created (form, UI, import, API).

export interface ClaimFields {
  name: string;
  firstName: string;
  email: string | null;
  phone: string | null; // E.164
  smsOptIn: boolean;
  statusLabel: string | null;
  amountClaimed: number | null;
  settlementAmount: number | null;
  // What is currently on the item, so write-backs only happen when needed.
  claimNumber: string | null;
  dateReceived: string | null; // YYYY-MM-DD
  portalLink: string | null;
}

// The columns readClaimFields needs. Items are fetched with only these, so
// internal columns (and file URLs) never leave Monday.
export function claimColumnIds(board: BoardConfig): string[] {
  const c = board.columns;
  return [c.claimNumber, c.status, c.email, c.phone, c.smsOptIn, c.amountClaimed, c.settlementAmount, c.dateReceived, c.portalLink].filter(
    (id): id is string => !!id,
  );
}

// The business's time zone: the dates claimants are told and the dates on the board.
export const BUSINESS_TIME_ZONE = 'America/New_York';

const ymdFormat = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

// "2026-10-21" for 2026-10-22T01:30Z: the calendar date in BUSINESS_TIME_ZONE.
export function businessDate(iso: string): string {
  const parts = Object.fromEntries(ymdFormat.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The item name comes from the public claim form, so it is the claimant's own
// text. A word that looks like a link, domain or email address is never put in
// a message: mail apps would make it clickable.
const LINK_LIKE_RE = /:\/\/|[/\\@<>]|www\.|\w\.[a-z]{2,}/i;
export const isLinkLike = (word: string): boolean => LINK_LIKE_RE.test(word);

// The name without link-like words.
export const cleanName = (name: string): string =>
  name
    .split(/\s+/)
    .filter((w) => w && !isLinkLike(w))
    .join(' ');

// The first word of the name for "Hi {{firstName}}"; '' (so "Hi there") when it
// looks like a link or is too long to be a name.
export function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.length <= 40 && !isLinkLike(first) ? first : '';
}

export function readClaimFields(board: BoardConfig, item: MondayItem): ClaimFields {
  const c = board.columns;
  const col = (id: string | undefined) => (id ? item.columnValues[id] : undefined);
  const name = item.name.trim();
  return {
    name,
    firstName: firstNameOf(name),
    email: parseEmail(col(c.email)),
    phone: parsePhone(col(c.phone)),
    smsOptIn: parseCheckbox(col(c.smsOptIn)),
    statusLabel: columnText(col(c.status)),
    amountClaimed: parseAmount(col(c.amountClaimed)),
    settlementAmount: parseAmount(col(c.settlementAmount)),
    claimNumber: columnText(col(c.claimNumber)),
    dateReceived: parseDate(col(c.dateReceived)),
    portalLink: columnText(col(c.portalLink)),
  };
}

export function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmpty = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim() : null);

// Rendered text, falling back to a text column's JSON string value.
export function columnText(cv: MondayColumnValue | undefined): string | null {
  if (!cv) return null;
  return nonEmpty(cv.text) ?? nonEmpty(parseJson(cv.value));
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

// Email column value is {"email","text"}; its `text` part is display text and may
// not be an address, so every candidate is validated.
export function parseEmail(cv: MondayColumnValue | undefined): string | null {
  if (!cv) return null;
  const v = parseJson(cv.value);
  const candidates = [isObj(v) ? v.email : null, typeof v === 'string' ? v : null, cv.text];
  for (const cand of candidates) {
    const s = nonEmpty(cand);
    if (s && s.length <= 254 && EMAIL_RE.test(s)) return s;
  }
  return null;
}

// E.164. Bare 10-digit numbers (and 11 digits starting with 1) are taken as
// US/Canada; anything else must carry its own + country code.
export function normalisePhone(raw: string | null | undefined): string | null {
  const s = nonEmpty(raw);
  if (!s || /[^\d\s()+.\-]/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? `+${digits}` : null;
  if (digits.length === 10 && !/^[01]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// Phone column value is {"phone","countryShortName"}; the number may be stored
// with or without its + prefix.
export function parsePhone(cv: MondayColumnValue | undefined): string | null {
  if (!cv) return null;
  const v = parseJson(cv.value);
  const stored = isObj(v) ? nonEmpty(v.phone) : typeof v === 'string' ? nonEmpty(v) : null;
  return normalisePhone(stored) ?? normalisePhone(cv.text);
}

// Checkbox value is {"checked":"true"} (Monday sends the string; accept a boolean
// too); its rendered text is "v" when ticked.
export function parseCheckbox(cv: MondayColumnValue | undefined): boolean {
  if (!cv) return false;
  const v = parseJson(cv.value);
  if (isObj(v) && 'checked' in v) return v.checked === true || v.checked === 'true';
  return (cv.text ?? '').trim().toLowerCase() === 'v';
}

// Numbers column. Empty or non-numeric -> null, never 0.
export function parseAmount(cv: MondayColumnValue | undefined): number | null {
  if (!cv) return null;
  for (const cand of [cv.text, parseJson(cv.value)]) {
    const raw = typeof cand === 'number' ? String(cand) : nonEmpty(cand);
    if (!raw) continue;
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) continue;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Date column value is {"date":"YYYY-MM-DD","time":...}; text is the date.
export function parseDate(cv: MondayColumnValue | undefined): string | null {
  if (!cv) return null;
  const v = parseJson(cv.value);
  const cand = (isObj(v) ? nonEmpty(v.date) : null) ?? nonEmpty(cv.text);
  const m = cand?.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

export const formatUsd = (amount: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

// "2026-10-22 14:03 UTC" for Monday updates.
export function formatUtc(iso: string | null): string {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return 'an unknown time';
  return `${t.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Runs a side effect (usually a Monday update) once per key. The key is recorded
// only after it succeeds, so a failed call is retried with its job instead of
// being lost. Jobs run one at a time, so check-then-record is safe here.
export async function onceFor(ctx: CoreContext, key: string, fn: (once: MondayWriteOptions) => Promise<unknown>): Promise<boolean> {
  if (ctx.repo.isEventProcessed(key)) return false;
  // Passed to the one Monday write fn makes, so a retry after a lost response
  // (the write applied, the key not yet marked) doesn't post it twice.
  await fn({ idempotencyKey: idempotencyKeyFor(key) });
  ctx.repo.markEventProcessed(key);
  return true;
}

// A Monday Idempotency-Key for a write that must happen once per `key` (Monday
// remembers it for 30 minutes). Hashed: keys can be long and carry ids.
export const idempotencyKeyFor = (key: string): string => `hdc-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;

// Records a system timeline entry once per key.
export function addSystemMessageOnce(ctx: CoreContext, key: string, itemId: string, body: string): void {
  ctx.db.transaction(() => {
    if (ctx.repo.markEventProcessed(key)) ctx.repo.addMessage({ itemId, direction: 'system', channel: 'monday', body });
  })();
}

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);
