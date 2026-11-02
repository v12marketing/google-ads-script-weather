import { emailToText } from '../adapters/highlevel/webhook.js';

// An email reply carries the quoted thread, and often a signature, below what the
// claimant just wrote. The team only needs the new text, so everything from the
// first quote marker on is dropped. If that leaves nothing (the claimant wrote
// below the quote), the whole message is kept rather than losing it.

const LOOKS_HTML = /<\/?(p|div|br|span|html|body|blockquote|table)\b[^>]*>/i;

// "On Tue, Oct 21, 2026 at 9:14 AM Home Delivery Claims <claims@...> wrote:".
// Gmail wraps long attributions, so "wrote:" may end the following line.
const ATTRIBUTION = /^On\s.{4,300}\swrote:$/i;
const ATTRIBUTION_START = /^On\s.{4,300}$/i;
const ATTRIBUTION_END = /^.{0,200}\bwrote:$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i;
const OUTLOOK_RULE = /^_{10,}$/;
const HEADER_FROM = /^From:\s/i;
const HEADER_NEXT = /^(Sent|Date|To|Subject):\s/i;
// RFC 3676 "-- " delimiter (many clients trim the trailing space) and the
// usual mobile footers.
const SIGNATURE = /^--\s?$/;
const MOBILE_FOOTER = /^(Sent from my\s.{1,40}|Sent from (Mail|Outlook|Yahoo Mail)\b.{0,40}|Get Outlook for (iOS|Android))$/i;

function quoteStartsAt(lines: string[], i: number): boolean {
  const line = lines[i]!.trim();
  const next = lines[i + 1]?.trim();
  if (ATTRIBUTION.test(line) || ORIGINAL_MESSAGE.test(line)) return true;
  if (ATTRIBUTION_START.test(line) && next !== undefined && ATTRIBUTION_END.test(next)) return true;
  if (OUTLOOK_RULE.test(line) && next !== undefined && HEADER_FROM.test(next)) return true;
  // Outlook's plain header block: From: ... followed by Sent:/Date:/To:/Subject:.
  return HEADER_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => HEADER_NEXT.test(l.trim()));
}

export function stripEmailReply(body: string): string {
  const text = (LOOKS_HTML.test(body) ? emailToText(body) : body)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (quoteStartsAt(lines, i) || SIGNATURE.test(line) || MOBILE_FOOTER.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  const reply = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return reply || text.replace(/\n{3,}/g, '\n\n');
}
