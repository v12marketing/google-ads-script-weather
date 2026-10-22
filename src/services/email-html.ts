import { escapeHtml, html, raw, type Html } from '../web/html.js';

// Turns a rendered plain-text template into a branded HTML email (inline styles,
// table layout, so it holds up in Outlook and Gmail) and a matching plain-text
// version. Every piece of text is escaped; http(s) URLs become links, and a link
// on its own line becomes a button when we know what it is.

const BRAND = 'Home Delivery Claims';
const FONT = raw("-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif");
const INK = '#12233a';
const INK_SOFT = '#4a5a70';
const BRAND_BG = '#0b3d5c';
// Darker than the site accent so white button text passes WCAG AA contrast.
const BUTTON_BG = '#0c7a70';
const PAGE_BG = '#f4f7fa';
const LINE = '#dbe3ec';

export interface EmailButton {
  url: string;
  label: string;
}

export interface EmailContent {
  subject: string;
  // Rendered template text: paragraphs separated by blank lines.
  bodyText: string;
  claimNumber: string;
  // URLs that become buttons when they sit on a line of their own. A claim page
  // link (/c/<token>) is always a "View your claim" button.
  buttons?: EmailButton[];
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const LONE_URL_RE = /^https?:\/\/[^\s<>"'`]+$/;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;
const CODE_RE = /^\d{6}$/; // a login code on its own line

const normalize = (s: string): string => s.replace(/\r\n?/g, '\n').trim();

const isClaimPageUrl = (url: string): boolean => {
  try {
    return /^\/c\/[A-Za-z0-9_-]{16,}$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

const link = (url: string): Html =>
  html`<a href="${url}" style="color:${BRAND_BG};text-decoration:underline;word-break:break-all;">${url}</a>`;

// Escapes text and links its http(s) URLs, leaving trailing punctuation outside the link.
function linkify(text: string): Html {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT_RE, '');
    if (!/^https?:\/\/./.test(url)) continue;
    out += escapeHtml(text.slice(last, m.index)) + link(url).value;
    last = m.index + url.length;
  }
  return raw(out + escapeHtml(text.slice(last)));
}

const paragraph = (lines: string[]): Html =>
  html`<p style="margin:0 0 16px;">${lines.map((l, i) => html`${i ? raw('<br>') : ''}${linkify(l)}`)}</p>`;

const button = (url: string, label: string): Html => html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;border-collapse:separate;">
<tr><td align="center" bgcolor="${BUTTON_BG}" style="background:${BUTTON_BG};border-radius:8px;">
<a href="${url}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
</td></tr>
</table>
<p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:${INK_SOFT};">If the button doesn't work, copy this link into your browser:<br>${link(url)}</p>`;

const codeBlock = (code: string): Html =>
  html`<p style="margin:0 0 16px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:${INK};">${code}</p>`;

function bodyHtml(text: string, buttons: Map<string, string>): Html {
  const labelFor = (line: string): string | null => {
    if (!LONE_URL_RE.test(line)) return null;
    return buttons.get(line) ?? (isClaimPageUrl(line) ? 'View your claim' : null);
  };
  const blocks: Html[] = [];
  for (const para of normalize(text).split(/\n[ \t]*\n+/)) {
    if (CODE_RE.test(para.trim())) {
      blocks.push(codeBlock(para.trim()));
      continue;
    }
    let lines: string[] = [];
    const flush = () => {
      if (lines.some((l) => l.trim())) blocks.push(paragraph(lines));
      lines = [];
    };
    for (const line of para.split('\n')) {
      const label = labelFor(line.trim());
      if (label) {
        flush();
        blocks.push(button(line.trim(), label));
      } else {
        lines.push(line);
      }
    }
    flush();
  }
  return html`${blocks}`;
}

const footerText = (claimNumber: string): string =>
  claimNumber.trim()
    ? `You're receiving this because you filed claim ${claimNumber.trim()} with ${BRAND}.`
    : `You're receiving this because a claim was filed with ${BRAND} using this email address.`;
const REPLY_NOTE = 'Replies to this email go to our claims team.';

export function renderEmailHtml(c: EmailContent): string {
  const buttons = new Map((c.buttons ?? []).filter((b) => b.url).map((b) => [b.url.trim(), b.label]));
  return (
    '<!doctype html>\n' +
    html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${c.subject}</title>
<style>
@media only screen and (max-width: 620px) {
  .container { width: 100% !important; }
  .px { padding-left: 20px !important; padding-right: 20px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:10px;">
<tr><td class="px" style="background:${BRAND_BG};padding:18px 32px;border-radius:10px 10px 0 0;font-family:${FONT};font-size:19px;font-weight:700;letter-spacing:0.01em;color:#ffffff;">${BRAND}</td></tr>
<tr><td class="px" style="padding:28px 32px 12px;font-family:${FONT};font-size:16px;line-height:1.6;color:${INK};">
${bodyHtml(c.bodyText, buttons)}
</td></tr>
<tr><td class="px" style="padding:16px 32px 24px;border-top:1px solid ${LINE};font-family:${FONT};font-size:13px;line-height:1.5;color:${INK_SOFT};">
<p style="margin:0 0 6px;">${footerText(c.claimNumber)}</p>
<p style="margin:0;">${REPLY_NOTE}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`.value
  );
}

export function renderEmailText(c: EmailContent): string {
  return `${normalize(c.bodyText)}\n\n--\n${footerText(c.claimNumber)}\n${REPLY_NOTE}\n`;
}
