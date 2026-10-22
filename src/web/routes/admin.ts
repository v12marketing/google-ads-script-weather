import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { formatClaimNumber } from '../../db/repo.js';
import {
  EVENT_TEMPLATE_KEYS,
  STATUS_KEYS,
  type Claim,
  type EventTemplateKey,
  type MessageTemplate,
  type StatusKey,
  type TemplateKey,
  type TemplateVars,
} from '../../domain/types.js';
import type { AppContext } from '../../services/contracts.js';
import type { JobRow } from '../../services/jobs.js';
import { EMAIL_ONLY_TEMPLATE_KEYS, formatDate, formatMoney } from '../../services/templates.js';
import {
  adminCsrfToken,
  FailureLimiter,
  parseBasicAuth,
  safeEqualStrings,
  VerifiedCredentialCache,
  verifyPassword,
} from '../admin-auth.js';
import { html, raw, textToHtml, type Html } from '../html.js';
import { page } from '../layout.js';

// The team's admin page: /admin. HTTP Basic auth against ADMIN_USER /
// ADMIN_PASSWORD_HASH, failed attempts limited per IP. Every POST carries a CSRF
// token and must come from our own origin. Never shows portal tokens.

const REALM = 'Basic realm="Home Delivery Claims admin", charset="UTF-8"';
const CSP =
  "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const TEMPLATE_KEYS: readonly TemplateKey[] = [...STATUS_KEYS, ...EVENT_TEMPLATE_KEYS];
// Only the text message of these is ever sent.
const SMS_ONLY_TEMPLATE_KEYS: ReadonlySet<TemplateKey> = new Set<TemplateKey>(['status_reply']);
// Placeholders a template must keep, or the message is useless.
const REQUIRED_VARS: Partial<Record<TemplateKey, Array<keyof TemplateVars>>> = {
  login_code: ['code'],
  claim_links: ['claimList'],
  new_message: ['message'],
};

const STATUS_NAMES: Record<StatusKey, string> = {
  received: 'Received',
  under_review: 'Under review',
  more_info_needed: 'More information needed',
  estimate_in_progress: 'Estimate in progress',
  settlement_offered: 'Settlement offered',
  settlement_signed: 'Settlement signed',
  payment_sent: 'Payment sent',
  closed: 'Closed',
  denied: 'Denied',
};

const EVENTS: Record<EventTemplateKey, { name: string; when: string }> = {
  confirmation: { name: 'New claim confirmation', when: 'Sent once when a new claim arrives and gets its claim number.' },
  new_message: { name: 'Message from the team', when: 'Sent when someone posts an update on the item that starts with the claimant prefix.' },
  login_code: { name: 'Sign-in code', when: 'Sent when the claimant opens their claim page in a new browser. Email only.' },
  claim_links: { name: 'Claim links', when: 'Sent from "Find my claim", and from the claim lookup on this admin page. Email only.' },
  status_reply: { name: 'STATUS text reply', when: 'Text sent back when the claimant texts STATUS. Only the text message is used.' },
};

const VAR_HELP: Record<keyof TemplateVars, string> = {
  firstName: "Claimant's first name",
  claimantName: "Claimant's full name",
  claimNumber: 'Claim number, e.g. HDC-000123',
  portalUrl: "The claimant's private claim page link",
  statusLabel: 'Current status label',
  dateReceived: 'Date the claim was received',
  amountClaimed: 'Amount claimed (never in text messages)',
  settlementAmount: 'Settlement amount (claim page and settlement document only, never in email or text)',
  paymentFormUrl: 'Link to the payment details form',
  message: 'The team message (new message template)',
  code: 'The sign-in code (sign-in code template)',
  claimList: 'Claim numbers and links (claim links template)',
};
const VAR_NAMES = Object.keys(VAR_HELP) as Array<keyof TemplateVars>;
const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const isStatusKey = (k: string): k is StatusKey => (STATUS_KEYS as readonly string[]).includes(k);
const isTemplateKey = (k: string): k is TemplateKey => (TEMPLATE_KEYS as readonly string[]).includes(k);
const templateName = (k: TemplateKey): string => (isStatusKey(k) ? `Status: ${STATUS_NAMES[k]}` : EVENTS[k].name);

const field = (body: unknown, name: string): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' ? first : undefined;
};
const query = (req: FastifyRequest, name: string): string | undefined => field(req.query, name);

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateTimeFormat.format(d);
};

// First line of a job error, with links masked in case a provider echoed one.
const errorLine = (e: string | null): string =>
  (e ?? '').split('\n')[0]!.replace(/https?:\/\/\S+/g, '[link]').slice(0, 300);

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);

// --- SMS length ---

const GSM7 = new Set(
  Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'),
);
const GSM7_EXT = new Set(Array.from('^{}\\[~]|€\f'));

export function smsLength(text: string): { chars: number; segments: number; encoding: 'GSM-7' | 'Unicode' } {
  let units = 0;
  for (const ch of text) {
    if (GSM7.has(ch)) units += 1;
    else if (GSM7_EXT.has(ch)) units += 2;
    else {
      const len = text.length; // UTF-16 code units, as carriers count them
      return { chars: len, segments: len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67), encoding: 'Unicode' };
    }
  }
  return { chars: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), encoding: 'GSM-7' };
}

const smsSummary = (text: string): string => {
  const s = smsLength(text);
  return s.chars === 0 ? 'empty (no text is sent)' : `${s.chars} characters, ${s.segments} text segment${s.segments === 1 ? '' : 's'} (${s.encoding})`;
};

// --- template checks ---

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
}

function templateProblems(t: MessageTemplate): string[] {
  const problems: string[] = [];
  const fields: Array<[string, string]> = [
    ['Email subject', t.emailSubject],
    ['Email body', t.emailBody],
    ['Text message', t.sms],
    ['Claim page text', t.portalText],
  ];
  for (const [label, text] of fields) {
    for (const name of new Set(placeholders(text))) {
      if (!(VAR_NAMES as string[]).includes(name)) problems.push(`${label}: {{${name}}} is not a known placeholder.`);
    }
  }
  const uses = (text: string, name: keyof TemplateVars) => placeholders(text).includes(name);
  if (uses(t.emailSubject, 'settlementAmount') || uses(t.emailBody, 'settlementAmount') || uses(t.sms, 'settlementAmount')) {
    problems.push('{{settlementAmount}} must not be used in email or text messages. It is shown on the claim page and in the settlement document.');
  }
  if (uses(t.sms, 'amountClaimed')) problems.push('{{amountClaimed}} must not be used in text messages.');
  for (const name of REQUIRED_VARS[t.key] ?? []) {
    if (!uses(t.emailBody, name)) problems.push(`The email body must include {{${name}}}.`);
  }
  if (SMS_ONLY_TEMPLATE_KEYS.has(t.key)) {
    if (!t.sms.trim()) problems.push('The text message cannot be empty.');
  } else {
    if (!t.emailSubject.trim()) problems.push('The email subject cannot be empty.');
    if (!t.emailBody.trim()) problems.push('The email body cannot be empty.');
  }
  return problems;
}

type ClaimFlash = { done?: string; warn?: string[] };

export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, board, db, repo, jobs, services, monday, highlevel, log } = ctx;
  const csrf = adminCsrfToken(config.APP_SECRET, config.ADMIN_USER);
  const limiter = new FailureLimiter();
  const verified = new VerifiedCredentialCache(config.APP_SECRET);
  const baseUrl = config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const publicOrigin = new URL(config.PUBLIC_BASE_URL).origin;

  const count = (sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

  // --- rendering ---

  const NAV: Array<[string, string]> = [
    ['/admin', 'Dashboard'],
    ['/admin/templates', 'Messages'],
    ['/admin/jobs', 'Jobs'],
    ['/admin/claims', 'Claims'],
  ];

  const adminPage = (title: string, body: Html, active?: string): string =>
    page({
      title: `${title} · Admin`,
      body: html`<nav class="admin-nav" aria-label="Admin">
  ${NAV.map(([href, label]) => html`<a href="${href}"${active === href ? raw(' aria-current="page"') : ''}>${label}</a>`)}
</nav>
<div class="admin">${body}</div>`,
      styles: ['admin.css'],
      noindex: true,
      minimalHeader: true,
    });

  const send = (reply: FastifyReply, status: number, title: string, body: Html, active?: string): FastifyReply =>
    reply.code(status).type('text/html; charset=utf-8').send(adminPage(title, body, active));

  const message = (heading: string, text: string): Html => html`<h1>${heading}</h1><p class="lead">${text}</p>`;
  const alert = (kind: 'success' | 'error' | 'info', text: string | Html): Html =>
    html`<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${text}</div>`;
  const csrfInput = (): Html => html`<input type="hidden" name="_csrf" value="${csrf}">`;
  const confirmBox = (text: string): Html =>
    html`<label class="confirm"><input type="checkbox" name="confirm" value="yes" required> <span>${text}</span></label>`;

  // --- request checks ---

  const sameOrigin = (req: FastifyRequest): boolean => {
    const allowed = new Set([publicOrigin, `${req.protocol}://${req.host}`]);
    const origin = req.headers.origin;
    if (origin !== undefined) return allowed.has(origin);
    const referer = req.headers.referer;
    if (referer === undefined) return true;
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  };

  await app.register(
    async (admin) => {
      admin.addHook('onSend', async (_req, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Robots-Tag', 'noindex, nofollow');
        reply.header('Content-Security-Policy', CSP);
        // Overrides the site-wide no-referrer so our own form posts carry Origin.
        reply.header('Referrer-Policy', 'same-origin');
        return payload;
      });

      admin.addHook('onRequest', async (req, reply) => {
        const ip = req.ip;
        const wait = limiter.blockedFor(ip);
        if (wait) {
          reply.header('Retry-After', String(wait));
          return send(reply, 429, 'Too many attempts', message('Too many sign-in attempts', `Please wait about ${Math.ceil(wait / 60)} minutes and try again.`));
        }
        const header = req.headers.authorization;
        if (header && verified.has(header)) return;
        const creds = parseBasicAuth(header);
        if (creds) {
          // Both checks always run, so timing doesn't reveal which one failed.
          const userOk = safeEqualStrings(creds.user, config.ADMIN_USER);
          const passOk = await verifyPassword(creds.password, config.ADMIN_PASSWORD_HASH);
          if (userOk && passOk) {
            limiter.succeed(ip);
            verified.add(header!);
            return;
          }
          limiter.fail(ip);
          log.warn({ ip }, 'admin: sign-in failed');
        }
        reply.header('WWW-Authenticate', REALM);
        return send(reply, 401, 'Sign in required', message('Sign in required', 'This page is for the claims team. Sign in with the admin user name and password.'));
      });

      admin.addHook('preHandler', async (req, reply) => {
        if (req.method !== 'POST') return;
        const token = field(req.body, '_csrf');
        if (!sameOrigin(req) || !token || !safeEqualStrings(token, csrf)) {
          log.warn({ route: req.routeOptions.url }, 'admin: CSRF check failed');
          return send(reply, 403, 'Request blocked', message('Request blocked', 'That form could not be verified. Go back, reload the page and try again.'));
        }
      });

      // Actions that change or send something carry a required confirmation box.
      const unconfirmed = (req: FastifyRequest, reply: FastifyReply): FastifyReply | null =>
        field(req.body, 'confirm') === 'yes'
          ? null
          : send(reply, 400, 'Please confirm', message('Please confirm', 'Tick the confirmation box to go ahead. Nothing was changed.'));

      admin.setErrorHandler((err, req, reply) => {
        const status = (err as { statusCode?: unknown }).statusCode;
        const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
        if (code >= 500) log.error({ route: req.routeOptions.url, err: errText(err) }, 'admin: request failed');
        return send(
          reply,
          code,
          'Error',
          code >= 500 ? message('Something went wrong', 'The request failed. Check the logs for details.') : message('Request not valid', 'Go back and try again.'),
        );
      });

      // --- dashboard ---

      admin.get('/', async (_req, reply) => {
        const byStatus = Object.fromEntries(
          (db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
        ) as Record<string, number>;
        const claims = count('SELECT COUNT(*) AS n FROM claims');
        const waitingMessages = count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'from_claimant' AND monday_update_id IS NULL");
        const waitingUploads = count("SELECT COUNT(*) AS n FROM files WHERE source = 'claimant' AND monday_asset_id IS NULL");
        const dead = byStatus.dead ?? 0;
        const pending = (byStatus.pending ?? 0) + (byStatus.running ?? 0);

        const stat = (n: number, label: string, href?: string, warn = false): Html =>
          html`<div class="stat${warn && n > 0 ? ' stat-warn' : ''}">
  <span class="stat-n">${n}</span>
  <span class="stat-label">${href ? html`<a href="${href}">${label}</a>` : label}</span>
</div>`;

        return send(
          reply,
          200,
          'Dashboard',
          html`<h1>Admin</h1>
${dead > 0 ? alert('error', html`${dead} background job${dead === 1 ? ' has' : 's have'} failed permanently. <a href="/admin/jobs?status=dead">Review and retry</a>.`) : ''}
<div class="stat-grid">
  ${stat(claims, 'Claims')}
  ${stat(waitingMessages, 'Claimant messages waiting to reach Monday', undefined, true)}
  ${stat(waitingUploads, 'Claimant uploads waiting to reach Monday', undefined, true)}
  ${stat(pending, 'Jobs waiting', '/admin/jobs?status=pending')}
  ${stat(dead, 'Jobs failed', '/admin/jobs?status=dead', true)}
</div>
<h2>Find a claim</h2>
${claimSearchForm('')}
<h2>Settings</h2>
<ul class="plain">
  <li>Text messages (SMS): <strong>${config.SMS_ENABLED ? 'on' : 'off'}</strong>${config.SMS_ENABLED ? '' : ' (email only until SMS_ENABLED=true)'}</li>
  <li>Monday webhook signatures: <strong>${config.MONDAY_SIGNING_SECRET ? 'checked' : 'not configured (secret link only)'}</strong></li>
  <li>Payment board verification: <strong>${board.paymentBoard ? 'on' : 'off'}</strong></li>
  ${board.claimsBoardUrl ? html`<li><a href="${board.claimsBoardUrl}" rel="noopener">Open the claims board in Monday</a></li>` : ''}
</ul>
<p><a class="btn btn-secondary" href="/admin/templates">Edit claimant messages</a></p>`,
          '/admin',
        );
      });

      // --- templates ---

      const boardLabels = (key: StatusKey): string[] =>
        Object.entries(board.statuses)
          .filter(([, k]) => k === key)
          .map(([label]) => label);

      const whenSent = (key: TemplateKey): string => {
        if (!isStatusKey(key)) return EVENTS[key].when;
        const labels = boardLabels(key);
        if (!labels.length) return 'No board status label is mapped to this status, so it is never sent.';
        const extra = key === 'settlement_offered' ? ' This also sends the settlement document for e-signature.' : '';
        return `Sent when the claim's status changes to ${labels.map((l) => `"${l}"`).join(' or ')}.${extra}`;
      };

      const sampleVars = (key: TemplateKey): TemplateVars => {
        const token = (s: string) => createHash('sha256').update(s).digest('base64url');
        const portalUrl = `${baseUrl}/c/${token('sample-1')}`;
        const pay = new URL(board.paymentForm.url);
        pay.searchParams.set(board.paymentForm.claimNumberParam, 'HDC-000123');
        pay.searchParams.set(board.paymentForm.signatureParam, token('sample-signature').slice(0, 22));
        const statusLabel = isStatusKey(key) ? (boardLabels(key)[0] ?? STATUS_NAMES[key]) : 'Under review';
        return {
          firstName: 'Jane',
          claimantName: 'Jane Doe',
          claimNumber: 'HDC-000123',
          portalUrl,
          statusLabel,
          dateReceived: formatDate(new Date().toISOString()),
          amountClaimed: formatMoney(1250),
          settlementAmount: formatMoney(980),
          paymentFormUrl: pay.toString(),
          message: 'Thanks for the photos. Could you also send a photo of the delivery label?',
          code: '483920',
          claimList: `HDC-000123 — ${portalUrl}\nHDC-000098 — ${baseUrl}/c/${token('sample-2')}`,
        };
      };

      admin.get('/templates', async (_req, reply) => {
        const rows = TEMPLATE_KEYS.map((key) => {
          const edited = repo.getTemplateOverride(key) !== null;
          return html`<tr>
  <td><a href="/admin/templates/${key}">${templateName(key)}</a></td>
  <td class="small">${whenSent(key)}</td>
  <td>${edited ? html`<span class="badge badge-edited">edited</span>` : html`<span class="badge badge-default">default</span>`}</td>
</tr>`;
        });
        return send(
          reply,
          200,
          'Messages',
          html`<h1>Claimant messages</h1>
<p class="lead">The email, text message and claim page wording sent to claimants. Edits take effect immediately.</p>
<div class="table-wrap"><table class="data">
  <thead><tr><th scope="col">Message</th><th scope="col">When it is sent</th><th scope="col">Wording</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`,
          '/admin/templates',
        );
      });

      interface EditState {
        t: MessageTemplate;
        flash?: Html;
        problems?: string[];
        preview?: boolean;
        status?: number;
      }

      const templateView = (key: TemplateKey, s: EditState): Html => {
        const { t } = s;
        const edited = repo.getTemplateOverride(key) !== null;
        const def = services.templates.getDefault(key);
        const emailOnly = EMAIL_ONLY_TEMPLATE_KEYS.has(key);
        const smsOnly = SMS_ONLY_TEMPLATE_KEYS.has(key);
        const status = isStatusKey(key);
        const vars = sampleVars(key);
        const render = (text: string) => services.templates.render(text, vars);
        const chars = (text: string) => `${text.length} characters`;

        const preview = s.preview
          ? html`<section class="card preview" aria-labelledby="preview-title">
  <h2 id="preview-title">Preview</h2>
  <p class="muted small">Filled in with sample values. Nothing has been saved or sent.</p>
  ${smsOnly ? '' : html`<h3>Email</h3>
  <p><strong>Subject:</strong> ${render(t.emailSubject)}</p>
  <div class="preview-email">${textToHtml(render(t.emailBody))}</div>`}
  ${emailOnly ? '' : html`<h3>Text message</h3>
  ${t.sms.trim() ? html`<p class="preview-sms">${render(t.sms)}</p>` : html`<p class="muted">No text message is sent for this.</p>`}
  <p class="small muted">${smsSummary(render(t.sms))}</p>`}
  ${status ? html`<h3>Claim page</h3><div class="preview-portal">${textToHtml(render(t.portalText))}</div>` : ''}
</section>`
          : '';

        return html`<p class="crumbs"><a href="/admin/templates">Claimant messages</a></p>
<h1>${templateName(key)} ${edited ? html`<span class="badge badge-edited">edited</span>` : html`<span class="badge badge-default">default</span>`}</h1>
<p class="lead">${whenSent(key)}</p>
${s.flash ?? ''}
${s.problems?.length ? alert('error', html`<p>Not saved. Please fix:</p><ul>${s.problems.map((p) => html`<li>${p}</li>`)}</ul>`) : ''}
${preview}
<form method="post" action="/admin/templates/${key}" class="template-form">
  ${csrfInput()}
  ${smsOnly
    ? ''
    : html`<label class="field"><span>Email subject</span>
    <input type="text" name="emailSubject" value="${t.emailSubject}" maxlength="200">
    <span class="hint">${chars(t.emailSubject)}</span></label>
  <label class="field"><span>Email body</span>
    <textarea name="emailBody" rows="16">${t.emailBody}</textarea>
    <span class="hint">Plain text. Leave a blank line between paragraphs. ${chars(t.emailBody)}.</span></label>`}
  ${emailOnly
    ? html`<p class="muted small">This message is only ever sent by email.</p>`
    : html`<label class="field"><span>Text message</span>
    <textarea name="sms" rows="4">${t.sms}</textarea>
    <span class="hint">${smsOnly ? '' : 'Leave empty to send no text. '}Start with "Home Delivery Claims:" and never include amounts. As typed: ${smsSummary(t.sms)}. With sample values: ${smsSummary(render(t.sms))}.</span></label>`}
  ${status
    ? html`<label class="field"><span>Claim page text ("what happens next")</span>
    <textarea name="portalText" rows="5">${t.portalText}</textarea>
    <span class="hint">${chars(t.portalText)}</span></label>`
    : ''}
  <div class="actions">
    <button class="btn btn-secondary" type="submit" name="action" value="preview">Preview</button>
    <button class="btn btn-primary" type="submit" name="action" value="save">Save</button>
  </div>
</form>

<details class="vars">
  <summary>Placeholders you can use</summary>
  <p class="small">Type them exactly as shown, including the double braces.</p>
  <table class="data">
    <tbody>${VAR_NAMES.map((n) => html`<tr><td><code>{{${n}}}</code></td><td class="small">${VAR_HELP[n]}</td></tr>`)}</tbody>
  </table>
</details>

<details class="default-text">
  <summary>Original wording</summary>
  ${smsOnly ? '' : html`<p><strong>Subject:</strong> ${def.emailSubject}</p><pre class="plaintext">${def.emailBody}</pre>`}
  ${emailOnly ? '' : html`<p><strong>Text message:</strong></p><pre class="plaintext">${def.sms || '(none)'}</pre>`}
  ${status ? html`<p><strong>Claim page text:</strong></p><pre class="plaintext">${def.portalText}</pre>` : ''}
</details>

${edited
  ? html`<form method="post" action="/admin/templates/${key}/reset" class="card danger-zone">
  ${csrfInput()}
  <h2>Go back to the original wording</h2>
  <p>This discards the edited wording for this message.</p>
  ${confirmBox('Yes, discard the edited wording')}
  <button class="btn btn-danger" type="submit">Reset to default</button>
</form>`
  : ''}`;
      };

      type KeyParams = { Params: { key: string } };

      admin.get<KeyParams>('/templates/:key', async (req, reply) => {
        const { key } = req.params;
        if (!isTemplateKey(key)) return send(reply, 404, 'Not found', message('Not found', 'There is no message with that name.'));
        const done = query(req, 'done');
        const flash = done === 'saved' ? alert('success', 'Saved. New messages use this wording.') : done === 'reset' ? alert('success', 'Reset to the original wording.') : undefined;
        return send(reply, 200, templateName(key), templateView(key, { t: services.templates.get(key), flash }), '/admin/templates');
      });

      admin.post<KeyParams>('/templates/:key', async (req, reply) => {
        const { key } = req.params;
        if (!isTemplateKey(key)) return send(reply, 404, 'Not found', message('Not found', 'There is no message with that name.'));
        const current = services.templates.get(key);
        const body = req.body;
        // Fields a template doesn't use keep their stored value.
        const smsOnly = SMS_ONLY_TEMPLATE_KEYS.has(key);
        const t: MessageTemplate = {
          key,
          emailSubject: smsOnly ? current.emailSubject : (field(body, 'emailSubject') ?? ''),
          emailBody: smsOnly ? current.emailBody : (field(body, 'emailBody') ?? ''),
          sms: EMAIL_ONLY_TEMPLATE_KEYS.has(key) ? '' : (field(body, 'sms') ?? ''),
          portalText: isStatusKey(key) ? (field(body, 'portalText') ?? '') : '',
        };
        const problems = templateProblems(t);

        if (field(body, 'action') === 'preview') {
          const flash = problems.length ? alert('info', html`<ul>${problems.map((p) => html`<li>${p}</li>`)}</ul>`) : undefined;
          return send(reply, 200, templateName(key), templateView(key, { t, preview: true, flash }), '/admin/templates');
        }
        if (problems.length) return send(reply, 400, templateName(key), templateView(key, { t, problems }), '/admin/templates');
        try {
          services.templates.save(t, config.ADMIN_USER);
        } catch (err) {
          return send(reply, 400, templateName(key), templateView(key, { t, problems: [errText(err)] }), '/admin/templates');
        }
        log.info({ key }, 'admin: template saved');
        return reply.redirect(`/admin/templates/${key}?done=saved`, 303);
      });

      admin.post<KeyParams>('/templates/:key/reset', async (req, reply) => {
        const { key } = req.params;
        if (!isTemplateKey(key)) return send(reply, 404, 'Not found', message('Not found', 'There is no message with that name.'));
        if (unconfirmed(req, reply)) return reply;
        services.templates.reset(key);
        log.info({ key }, 'admin: template reset');
        return reply.redirect(`/admin/templates/${key}?done=reset`, 303);
      });

      // --- jobs ---

      admin.get('/jobs', async (req, reply) => {
        const status = query(req, 'status') === 'pending' ? 'pending' : 'dead';
        const list: JobRow[] = jobs.list(status, 200);
        const retried = query(req, 'retried');
        const tabs = html`<nav class="tabs" aria-label="Job lists">
  <a href="/admin/jobs?status=dead"${status === 'dead' ? raw(' aria-current="page"') : ''}>Failed</a>
  <a href="/admin/jobs?status=pending"${status === 'pending' ? raw(' aria-current="page"') : ''}>Waiting</a>
</nav>`;
        const rows = list.map(
          (j) => html`<tr>
  <td>${j.id}</td>
  <td><code>${j.type}</code></td>
  <td>${j.attempts}</td>
  <td class="small err">${errorLine(j.last_error)}</td>
  <td class="small nowrap">${formatDateTime(j.run_at)}</td>
  ${status === 'dead'
    ? html`<td><form method="post" action="/admin/jobs/${j.id}/retry">${csrfInput()}<button class="btn btn-secondary btn-small" type="submit">Retry</button></form></td>`
    : ''}
</tr>`,
        );
        return send(
          reply,
          200,
          'Jobs',
          html`<h1>Background jobs</h1>
<p class="lead">${status === 'dead'
            ? 'Jobs that failed every retry. Fix the cause (see the error), then retry. Retrying is safe: jobs are idempotent.'
            : 'Jobs waiting to run, including ones that failed and will retry automatically.'}</p>
${retried && /^\d+$/.test(retried) ? alert('success', `Job ${retried} will run again shortly.`) : ''}
${tabs}
${list.length
  ? html`<div class="table-wrap"><table class="data">
  <thead><tr><th scope="col">ID</th><th scope="col">Type</th><th scope="col">Attempts</th><th scope="col">Last error</th><th scope="col">${status === 'dead' ? 'Failed after' : 'Runs at'}</th>${status === 'dead' ? html`<th scope="col"><span class="visually-hidden">Action</span></th>` : ''}</tr></thead>
  <tbody>${rows}</tbody>
</table></div>`
  : html`<p class="muted">None.</p>`}`,
          '/admin/jobs',
        );
      });

      admin.post<{ Params: { id: string } }>('/jobs/:id/retry', async (req, reply) => {
        const { id } = req.params;
        if (!/^\d{1,12}$/.test(id)) return send(reply, 404, 'Not found', message('Not found', 'There is no such job.'));
        const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(Number(id)) as { status: string } | undefined;
        if (!row) return send(reply, 404, 'Not found', message('Not found', 'There is no such job.'));
        jobs.retry(Number(id));
        log.info({ jobId: Number(id) }, 'admin: job retried');
        return reply.redirect(`/admin/jobs?status=dead&retried=${id}`, 303);
      });

      // --- claims ---

      function claimSearchForm(q: string): Html {
        return html`<form method="get" action="/admin/claims" class="search">
  <label class="field"><span>Claim number, Monday item id or email</span>
    <input type="text" name="q" value="${q}" placeholder="HDC-000123" maxlength="254" autocomplete="off"></label>
  <button class="btn btn-primary" type="submit">Look up</button>
</form>`;
      }

      const findClaims = (q: string): Claim[] | null => {
        const m = /^HDC-?(\d{1,6})$/i.exec(q);
        if (m) {
          const c = repo.getClaimByNumber(formatClaimNumber(Number(m[1])));
          return c ? [c] : [];
        }
        // Bare digits: a short claim number ("123"), else a Monday item id.
        if (/^\d{1,20}$/.test(q)) {
          const c = (q.length <= 6 ? repo.getClaimByNumber(formatClaimNumber(Number(q))) : null) ?? repo.getClaim(q);
          return c ? [c] : [];
        }
        if (q.includes('@') && q.length <= 254) return repo.findClaimsByEmail(q).slice(0, 50);
        return null;
      };

      const settlementState = (c: Claim): string => {
        if (c.paymentDetailsReceivedAt) return `Signed; payment details received ${formatDateTime(c.paymentDetailsReceivedAt)}`;
        if (c.settlementSignedAt) return `Signed ${formatDateTime(c.settlementSignedAt)}; waiting for payment details`;
        if (c.settlementSentAt) return `Sent ${formatDateTime(c.settlementSentAt)} for ${formatMoney(c.settlementAmountSent) || 'an unknown amount'}; waiting for signature`;
        return 'Not sent';
      };

      const claimFlash = (c: Claim, f: ClaimFlash): Html => {
        const warn = new Set(f.warn ?? []);
        const notes: Html[] = [];
        switch (f.done) {
          case 'link-sent':
            notes.push(alert('success', `The claim link was emailed to ${c.email ?? 'the claimant'}.`));
            break;
          case 'link-not-sent':
            notes.push(alert('error', 'Nothing was sent: this claim has no email address.'));
            break;
          case 'send-failed':
            notes.push(alert('error', 'Sending failed. Try again in a few minutes; the logs have details.'));
            break;
          case 'link-replaced':
            notes.push(
              alert(
                'success',
                'The claim link was replaced. The old link no longer works and every browser must sign in again. The claimant has not been told: email them the new link below.',
              ),
            );
            break;
          case 'link-written':
            notes.push(alert('success', 'The current claim link was written to Monday.'));
            break;
        }
        if (warn.has('monday')) {
          notes.push(
            alert(
              'error',
              html`Writing the new link to the Monday item failed, so Monday still shows the old one.
<form method="post" action="/admin/claims/${c.itemId}/write-link" class="inline-form">${csrfInput()}<button class="btn btn-secondary btn-small" type="submit">Try again</button></form>`,
            ),
          );
        }
        if (warn.has('highlevel')) notes.push(alert('error', 'Updating the link on the HighLevel contact failed. It updates again the next time the contact is saved.'));
        return html`${notes}`;
      };

      const claimDetail = (c: Claim, f: ClaimFlash): Html => {
        const messages = count('SELECT COUNT(*) AS n FROM messages WHERE item_id = ?', c.itemId);
        const waitingMessages = count(
          "SELECT COUNT(*) AS n FROM messages WHERE item_id = ? AND direction = 'from_claimant' AND monday_update_id IS NULL",
          c.itemId,
        );
        const files = count('SELECT COUNT(*) AS n FROM files WHERE item_id = ?', c.itemId);
        const waitingFiles = count("SELECT COUNT(*) AS n FROM files WHERE item_id = ? AND source = 'claimant' AND monday_asset_id IS NULL", c.itemId);
        const devices = count('SELECT COUNT(*) AS n FROM devices WHERE item_id = ? AND token_version = ?', c.itemId, c.tokenVersion);
        const sms = c.smsOptedOut ? 'Opted out (texted STOP)' : c.smsOptIn ? 'Opted in' : 'Not opted in';
        const itemLink = board.claimsBoardUrl
          ? html`<a href="${board.claimsBoardUrl.replace(/\/+$/, '')}/pulses/${c.itemId}" rel="noopener">${c.itemId}</a>`
          : c.itemId;
        const row = (label: string, value: Html | string | number) => html`<dt>${label}</dt><dd>${value === '' ? html`<span class="muted">none</span>` : value}</dd>`;

        return html`<h1>Claim ${c.claimNumber}</h1>
${claimFlash(c, f)}
<dl class="kv">
  ${row('Status', c.statusLabel ? `${c.statusLabel}${c.statusKey ? ` (${STATUS_NAMES[c.statusKey]})` : ''}` : 'Not set')}
  ${row('Claimant', c.claimantName)}
  ${row('Email', c.email ?? '')}
  ${row('Phone', c.phone ?? '')}
  ${row('Text messages', sms)}
  ${row('Amount claimed', formatMoney(c.amountClaimed))}
  ${row('Settlement amount', formatMoney(c.settlementAmount))}
  ${row('Settlement', settlementState(c))}
  ${row('Received', formatDateTime(c.receivedAt))}
  ${row('Last updated', formatDateTime(c.updatedAt))}
  ${row('Messages', `${messages}${waitingMessages ? ` (${waitingMessages} waiting to reach Monday)` : ''}`)}
  ${row('Files', `${files}${waitingFiles ? ` (${waitingFiles} waiting to reach Monday)` : ''}`)}
  ${row('Signed-in browsers', devices)}
  ${row('Monday item', itemLink)}
  ${row('HighLevel contact', c.highlevelContactId ?? 'Not created yet')}
</dl>

<div class="grid-2 actions-grid">
  <form method="post" action="/admin/claims/${c.itemId}/send-link" class="card">
    ${csrfInput()}
    <h2>Email the claimant their claim link</h2>
    <p>Sends the "Claim links" email with this claim's private link to ${c.email ?? 'the claimant (no email on file)'}.</p>
    ${confirmBox(`Yes, email the link for ${c.claimNumber}`)}
    <button class="btn btn-primary" type="submit"${c.email ? '' : raw(' disabled')}>Email the link</button>
  </form>
  <form method="post" action="/admin/claims/${c.itemId}/replace-link" class="card danger-zone">
    ${csrfInput()}
    <h2>Replace the claim link</h2>
    <p>Use this if the link reached the wrong person. The current link stops working at once and every browser has to sign in again with a code.${board.columns.portalLink ? ' The new link is written to the Monday item.' : ''} The claimant is not emailed until you send the new link.</p>
    ${confirmBox(`Yes, replace the link for ${c.claimNumber}`)}
    <button class="btn btn-danger" type="submit">Replace the link</button>
  </form>
</div>`;
      };

      admin.get('/claims', async (req, reply) => {
        const q = (query(req, 'q') ?? '').trim().slice(0, 254);
        let body: Html;
        let status = 200;
        if (!q) {
          body = html`<h1>Claims</h1>${claimSearchForm('')}`;
        } else {
          const found = findClaims(q);
          if (found === null) {
            status = 400;
            body = html`<h1>Claims</h1>${alert('error', 'Enter a claim number like HDC-000123, a Monday item id or an email address.')}${claimSearchForm(q)}`;
          } else if (found.length === 0) {
            status = 404;
            body = html`<h1>Claims</h1>${alert('info', 'No claim found.')}${claimSearchForm(q)}`;
          } else if (found.length === 1) {
            const warn = (query(req, 'warn') ?? '').split(',').filter(Boolean);
            body = html`${claimDetail(found[0]!, { done: query(req, 'done'), warn })}<h2>Look up another claim</h2>${claimSearchForm('')}`;
          } else {
            body = html`<h1>Claims</h1>${claimSearchForm(q)}
<div class="table-wrap"><table class="data">
  <thead><tr><th scope="col">Claim</th><th scope="col">Claimant</th><th scope="col">Status</th><th scope="col">Received</th></tr></thead>
  <tbody>${found.map(
    (c) => html`<tr><td><a href="/admin/claims?q=${c.claimNumber}">${c.claimNumber}</a></td><td>${c.claimantName}</td><td>${c.statusLabel ?? ''}</td><td class="nowrap">${formatDate(c.receivedAt)}</td></tr>`,
  )}</tbody>
</table></div>`;
          }
        }
        return send(reply, status, 'Claims', body, '/admin/claims');
      });

      type ItemParams = { Params: { itemId: string } };
      const claimFor = (itemId: string): Claim | null => (/^\d{1,20}$/.test(itemId) ? repo.getClaim(itemId) : null);
      const backTo = (c: Claim, done: string, warn: string[] = []) =>
        `/admin/claims?q=${encodeURIComponent(c.claimNumber)}&done=${done}${warn.length ? `&warn=${warn.join(',')}` : ''}`;
      const noClaim = (reply: FastifyReply) => send(reply, 404, 'Not found', message('Not found', 'There is no claim with that item id.'), '/admin/claims');

      admin.post<ItemParams>('/claims/:itemId/send-link', async (req, reply) => {
        const claim = claimFor(req.params.itemId);
        if (!claim) return noClaim(reply);
        if (unconfirmed(req, reply)) return reply;
        if (!claim.email?.trim()) return reply.redirect(backTo(claim, 'link-not-sent'), 303);
        try {
          const claimList = `${claim.claimNumber} — ${services.tokens.portalUrl(claim)}`;
          const res = await services.notifier.notify(claim, 'claim_links', { claimList });
          log.info({ itemId: claim.itemId, emailSent: res.emailSent }, 'admin: claim link emailed');
          return reply.redirect(backTo(claim, res.emailSent ? 'link-sent' : 'link-not-sent'), 303);
        } catch (err) {
          log.error({ itemId: claim.itemId, err: errText(err) }, 'admin: emailing claim link failed');
          return reply.redirect(backTo(claim, 'send-failed'), 303);
        }
      });

      const writeLinkToMonday = async (c: Claim): Promise<boolean> => {
        const col = board.columns.portalLink;
        if (!col) return true;
        try {
          await monday.changeColumnValues(board.claimsBoardId, c.itemId, { [col]: services.tokens.portalUrl(c) });
          return true;
        } catch (err) {
          log.error({ itemId: c.itemId, err: errText(err) }, 'admin: writing the claim link to Monday failed');
          return false;
        }
      };

      admin.post<ItemParams>('/claims/:itemId/replace-link', async (req, reply) => {
        const found = claimFor(req.params.itemId);
        if (!found) return noClaim(reply);
        if (unconfirmed(req, reply)) return reply;
        const itemId = found.itemId;
        // Bumping the version changes the derived link; the old one no longer
        // matches the stored hash, and trusted browsers are forgotten.
        const claim = repo.rotatePortalToken(itemId, (id, v) => services.tokens.tokenHash(services.tokens.portalToken(id, v)));
        if (!claim) return noClaim(reply);
        log.info({ itemId, tokenVersion: claim.tokenVersion }, 'admin: claim link replaced');

        const warn: string[] = [];
        if (!(await writeLinkToMonday(claim))) warn.push('monday');
        if (claim.highlevelContactId) {
          try {
            await highlevel.updateContactFields(claim.highlevelContactId, { portal_url: services.tokens.portalUrl(claim) });
          } catch (err) {
            log.warn({ itemId, err: errText(err) }, 'admin: updating the HighLevel contact link failed');
            warn.push('highlevel');
          }
        }
        return reply.redirect(backTo(claim, 'link-replaced', warn), 303);
      });

      admin.post<ItemParams>('/claims/:itemId/write-link', async (req, reply) => {
        const claim = claimFor(req.params.itemId);
        if (!claim) return noClaim(reply);
        const ok = await writeLinkToMonday(claim);
        return reply.redirect(ok ? backTo(claim, 'link-written') : backTo(claim, '', ['monday']), 303);
      });
    },
    { prefix: '/admin' },
  );
}
