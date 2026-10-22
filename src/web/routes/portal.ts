import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { statusKeyForLabel } from '../../board-config.js';
import type { Claim, ClaimFile, ClaimMessage, StatusKey } from '../../domain/types.js';
import { DEVICE_ID_RE, maskEmail } from '../../services/auth.js';
import type { AppContext } from '../../services/contracts.js';
import { ClaimantInputError } from '../../services/errors.js';
import { ALLOWED_UPLOAD_EXTENSIONS } from '../../services/files.js';
import { MAX_MESSAGE_CHARS } from '../../services/messaging.js';
import { formatDate, formatMoney } from '../../services/templates.js';
import { html, raw, textToHtml, type Html } from '../html.js';
import { page } from '../layout.js';

// The claimant's private claim page: /c/<token>. A browser must first prove it
// can read the claim's email (one-time code); after that its signed device
// cookie is trusted for the claim. Nothing about the claim is shown, and no code
// is sent, on a plain GET from an unverified browser: email link scanners fetch
// links before the claimant does.

export const DEVICE_COOKIE = 'hdc_device';
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60; // the longest browsers allow

// Raster images browsers render safely inline. Everything else is a download.
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// A hint for the file picker; the files service decides what is accepted.
const UPLOAD_ACCEPT = [
  'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,video/mp4,video/quicktime,application/pdf',
  ...ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`),
].join(',');
const MAX_FILES_PER_UPLOAD = 10; // matches the multipart `files` limit in app.ts

const STEPS = ['Received', 'Under review', 'Settlement', 'Payment', 'Closed'] as const;
// Index into STEPS of the stage each status has reached.
const STAGE: Record<Exclude<StatusKey, 'denied'>, number> = {
  received: 0,
  under_review: 1,
  more_info_needed: 1,
  estimate_in_progress: 1,
  settlement_offered: 2,
  settlement_signed: 3,
  payment_sent: 3,
  closed: 4,
};

const FALLBACK_LABELS: Record<StatusKey, string> = {
  received: 'Received',
  under_review: 'Under review',
  more_info_needed: 'More information needed',
  estimate_in_progress: 'Estimate in progress',
  settlement_offered: 'Settlement offered',
  settlement_signed: 'Settlement signed',
  payment_sent: 'Payment sent',
  closed: 'Closed',
  denied: 'Not approved',
};

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateTimeFormat.format(d);
};

const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const isInlineImage = (f: ClaimFile): boolean => INLINE_IMAGE_TYPES.has(f.mimeType.trim().toLowerCase());

// Downloads keep their type unless it is one a browser could execute or that isn't a valid header value.
function downloadType(mime: string): string {
  const m = mime.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(m)) return 'application/octet-stream';
  return /html|svg|xml|javascript|ecmascript/.test(m) ? 'application/octet-stream' : m;
}

// RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name.
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_').trim().slice(0, 150) || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const field = (body: unknown, name: string): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' ? first : undefined;
};

const errorCode = (err: unknown): string | undefined =>
  err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined;

type TokenParams = { Params: { token: string } };

interface ClaimViewOptions {
  notice?: string;
  messageError?: string;
  draft?: string;
  uploadErrors?: Array<{ name: string | null; message: string }>;
}

type VerifyStage = 'start' | 'code' | 'locked';

export async function registerPortalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repo, services, log, config } = ctx;
  const auth = services.auth;

  // --- rendering ---

  const portalPage = (title: string, body: Html): string =>
    page({ title, body, styles: ['portal.css'], scripts: ['portal.js'], noindex: true, minimalHeader: true });

  const sendHtml = (reply: FastifyReply, status: number, title: string, body: Html): FastifyReply =>
    reply.code(status).type('text/html; charset=utf-8').send(portalPage(title, body));

  const notFound = (reply: FastifyReply): FastifyReply =>
    sendHtml(
      reply,
      404,
      "This link isn't valid anymore",
      html`<div class="portal-narrow">
<h1>This link isn't valid anymore</h1>
<p class="lead">The link may be old, incomplete or mistyped. For your security, we sometimes replace claim links, and older ones stop working.</p>
<p>We can email you a fresh link to your claim. Use the email address you gave when you filed it.</p>
<p><a class="btn btn-primary" href="/find-my-claim">Email me my claim link</a></p>
</div>`,
    );

  const notice = (title: string, text: string, link: { href: string; label: string } | null): Html =>
    html`<div class="portal-narrow">
<h1>${title}</h1>
<p class="lead">${text}</p>
${link ? html`<p><a class="btn btn-primary" href="${link.href}">${link.label}</a></p>` : ''}
</div>`;

  const formExpired = (reply: FastifyReply, token: string): FastifyReply =>
    sendHtml(
      reply,
      403,
      'Please try again',
      notice(
        'Please try again',
        "That form had expired, so we didn't act on it. Please go back to your claim page and try again. If this keeps happening, check that cookies are turned on for this site.",
        { href: `/c/${token}`, label: 'Back to your claim' },
      ),
    );

  const needsVerification = (reply: FastifyReply, token: string): FastifyReply =>
    sendHtml(
      reply,
      403,
      'Please verify this device',
      notice('Please verify this device', "Open your claim link again and we'll check it's you with a code sent to your email.", {
        href: `/c/${token}`,
        label: 'Open your claim',
      }),
    );

  const csrfField = (deviceId: string, claim: Claim): Html =>
    html`<input type="hidden" name="_csrf" value="${auth.csrfToken(deviceId, claim.itemId)}">`;

  function verifyView(claim: Claim, token: string, deviceId: string, stage: VerifyStage, alert?: { kind: 'error' | 'info'; text: string }): Html {
    const base = `/c/${token}`;
    const masked = maskEmail(claim.email);
    const csrf = csrfField(deviceId, claim);
    const alertBox = alert ? html`<div class="alert alert-${alert.kind}" role="${alert.kind === 'error' ? 'alert' : 'status'}">${alert.text}</div>` : '';

    if (!masked) {
      return html`<div class="portal-narrow">
<h1>Open your claim</h1>
<div class="card stack">
<p>To keep your claim private, we check it's really you with a code sent to your email address. We don't have an email address on this claim yet, so we can't send one.</p>
<p>Please reply to any email or text message you've had from us, and our claims team will help you get access.</p>
</div>
</div>`;
    }

    const sendCodeForm = (label: string, primary: boolean): Html => html`<form method="post" action="${base}/code" class="${primary ? '' : 'inline-form'}">
${csrf}
<button type="submit" class="${primary ? 'btn btn-primary btn-block' : 'link-button'}" data-busy-label="Sending…">${label}</button>
</form>`;

    const intro = html`<p>To keep your claim private, we check it's really you the first time you open it on a new phone, tablet or computer.</p>`;

    if (stage === 'start') {
      return html`<div class="portal-narrow">
<h1>Open your claim</h1>
${alertBox}
<div class="card stack">
${intro}
<p>We'll email a 6-digit code to <strong>${masked}</strong>. Enter it on the next screen and this device will be remembered.</p>
${sendCodeForm('Email me a code', true)}
<p class="small muted"><a href="${base}?code=enter">I already have a code</a></p>
</div>
</div>`;
    }

    if (stage === 'locked') {
      return html`<div class="portal-narrow">
<h1>Open your claim</h1>
${alertBox}
<div class="card stack">
<p>For your security, that code can't be used anymore. We can email a new one to <strong>${masked}</strong>.</p>
${sendCodeForm('Email me a new code', true)}
</div>
</div>`;
    }

    return html`<div class="portal-narrow">
<h1>Enter your code</h1>
${alertBox}
<div class="card stack">
<p>Enter the 6-digit code we emailed to <strong>${masked}</strong>. Codes work for 10 minutes. If you can't find the email, check your spam or junk folder.</p>
<form method="post" action="${base}/verify" class="code-form">
${csrf}
<label class="field" for="code"><span>Your 6-digit code</span>
<input type="text" id="code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus>
</label>
<button type="submit" class="btn btn-primary btn-block" data-busy-label="Checking…">Verify and open my claim</button>
</form>
<div class="small muted resend">Didn't get it? ${sendCodeForm('Send a new code', false)}</div>
</div>
</div>`;
  }

  // Only labels that map to a claimant status are shown; anything else on the board is internal.
  function statusText(claim: Claim): string {
    if (!claim.statusKey) return 'Received';
    const label = claim.statusLabel?.trim();
    return label && statusKeyForLabel(ctx.board, label) === claim.statusKey ? label : FALLBACK_LABELS[claim.statusKey];
  }

  function tracker(claim: Claim): Html {
    if (claim.statusKey === 'denied') {
      return html`<ol class="tracker tracker-denied" aria-label="Claim progress">
<li class="step done"><span class="dot" aria-hidden="true"></span><span class="step-label">Received</span></li>
<li class="step done"><span class="dot" aria-hidden="true"></span><span class="step-label">Under review</span></li>
<li class="step denied" aria-current="step"><span class="dot" aria-hidden="true"></span><span class="step-label">Not approved</span></li>
</ol>`;
    }
    let stage = STAGE[claim.statusKey ?? 'received'];
    if (claim.settlementSignedAt) stage = Math.max(stage, STAGE.settlement_signed);
    // Once paid, the payment step is complete rather than in progress.
    const complete = claim.statusKey === 'payment_sent' || claim.statusKey === 'closed';
    return html`<ol class="tracker" aria-label="Claim progress">
${STEPS.map((label, i) => {
  const state = i < stage || (i === stage && complete) ? 'done' : i === stage ? 'current' : 'todo';
  return html`<li class="step ${state}"${state === 'current' ? raw(' aria-current="step"') : ''}><span class="dot" aria-hidden="true"></span><span class="step-label">${label}</span><span class="visually-hidden">${state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span></li>`;
})}
</ol>`;
  }

  function actionPanels(claim: Claim): Html {
    const panels: Html[] = [];
    if (claim.statusKey === 'settlement_offered') {
      const amount = formatMoney(claim.settlementAmountSent ?? claim.settlementAmount);
      panels.push(html`<section class="card panel panel-action" aria-labelledby="settlement-title">
<h2 id="settlement-title">Your settlement offer</h2>
${amount ? html`<p class="amount">${amount}</p>` : ''}
<p>${
        claim.settlementSentAt
          ? 'We emailed you the settlement document to sign; it comes from Home Delivery Claims.'
          : "We're emailing you the settlement document to sign; it comes from Home Delivery Claims."
      } Please read it and, if you agree, sign it electronically. It only takes a few minutes.</p>
<p class="small muted">Questions about the offer? Send us a message below before you sign.</p>
</section>`);
    }

    const signed = !!claim.settlementSignedAt || claim.statusKey === 'settlement_signed';
    const finished = claim.statusKey === 'payment_sent' || claim.statusKey === 'closed' || claim.statusKey === 'denied';
    if (signed && !finished) {
      if (claim.paymentDetailsReceivedAt) {
        panels.push(html`<section class="card panel panel-success" aria-labelledby="payment-title">
<h2 id="payment-title">Payment details received</h2>
<p>Thank you. Our finance team has your payment details and will send your payment. We'll let you know when it's on its way.</p>
</section>`);
      } else {
        panels.push(html`<section class="card panel panel-action" aria-labelledby="payment-title">
<h2 id="payment-title">Choose how you'd like to be paid</h2>
<p>You can be paid by <strong>mailed check</strong> or by <strong>direct deposit</strong> (ACH) to your bank account. For direct deposit you'll need your bank's routing number and your account number.</p>
<p><a class="btn btn-primary" href="${services.payment.paymentFormUrl(claim)}" target="_blank" rel="noopener noreferrer">Open the secure payment form</a></p>
<p class="small muted">The form opens in a new tab. Your bank details go directly to our finance team's secure form; they aren't shown on this page or sent by email. Please never send bank details by email, text or in a message.</p>
</section>`);
      }
    }
    return html`${panels}`;
  }

  function messageItem(m: ClaimMessage): Html {
    const when = formatDateTime(m.createdAt);
    if (m.direction === 'system') {
      return html`<li class="msg msg-event"><span class="msg-event-text">${m.body}</span>${when ? html` <time datetime="${m.createdAt}">${when}</time>` : ''}</li>`;
    }
    const mine = m.direction === 'from_claimant';
    return html`<li class="msg ${mine ? 'msg-you' : 'msg-team'}">
<div class="msg-meta"><strong>${mine ? 'You' : 'Claims team'}</strong>${when ? html` <time datetime="${m.createdAt}">${when}</time>` : ''}</div>
<div class="msg-body">${textToHtml(m.body)}</div>
</li>`;
  }

  function claimView(claim: Claim, token: string, deviceId: string, o: ClaimViewOptions = {}): Html {
    const base = `/c/${token}`;
    const csrf = csrfField(deviceId, claim);
    const portalText = services.templates.get(claim.statusKey ?? 'received').portalText.trim();
    const messages = repo.listMessages(claim.itemId);
    const files = repo.listFiles(claim.itemId);
    const photos = files.filter(isInlineImage);
    const documents = files.filter((f) => !isInlineImage(f));
    const fileUrl = (f: ClaimFile) => `${base}/files/${f.id}`;
    const from = (f: ClaimFile) => (f.source === 'team' ? 'From the claims team' : 'Added by you');
    const badgeClass = claim.statusKey === 'denied' ? 'badge badge-denied' : claim.statusKey === 'closed' || claim.statusKey === 'payment_sent' ? 'badge badge-done' : 'badge';
    const received = formatDate(claim.receivedAt);
    const maxMb = Math.floor(config.MAX_UPLOAD_BYTES / (1024 * 1024));

    return html`<div class="claim-page">
<header class="claim-head">
  <p class="claim-kicker">Your claim</p>
  <h1>${claim.claimNumber}</h1>
  <p class="claim-status"><span class="${badgeClass}">${statusText(claim)}</span>${received ? html` <span class="muted small">Filed ${received}</span>` : ''}</p>
</header>
${o.notice ? html`<div class="alert alert-success" role="status">${o.notice}</div>` : ''}
${tracker(claim)}
${actionPanels(claim)}
${
  portalText
    ? html`<section class="card next-steps" aria-labelledby="next-title">
<h2 id="next-title">What happens next</h2>
${textToHtml(portalText)}
</section>`
    : ''
}

<section class="card" id="messages" aria-labelledby="messages-title">
<h2 id="messages-title">Messages</h2>
${
  messages.length
    ? html`<ol class="thread">${messages.map(messageItem)}</ol>`
    : html`<p class="muted">No messages yet. If you have a question about your claim, write to us below.</p>`
}
<form method="post" action="${base}/messages#messages" class="reply-form">
${csrf}
${o.messageError ? html`<div class="alert alert-error" role="alert" id="message-error">${o.messageError}</div>` : ''}
<label class="field" for="message"><span>Write to the claims team</span>
<textarea id="message" name="message" rows="5" maxlength="${MAX_MESSAGE_CHARS}" required${o.messageError ? raw(' aria-describedby="message-error"') : ''}>${o.draft ?? ''}</textarea>
</label>
<p class="hint">We'll reply here and let you know by email.</p>
<button type="submit" class="btn btn-primary" data-busy-label="Sending…">Send message</button>
</form>
</section>

<section class="card" id="files" aria-labelledby="files-title">
<h2 id="files-title">Photos and documents</h2>
${
  photos.length
    ? html`<h3>Photos</h3>
<ul class="photo-grid">${photos.map(
        (f) => html`<li><a href="${fileUrl(f)}" target="_blank" rel="noopener"><img src="${fileUrl(f)}" alt="${f.name}" loading="lazy"></a><span class="photo-meta">${from(f)}</span></li>`,
      )}</ul>`
    : ''
}
${
  documents.length
    ? html`<h3>Documents</h3>
<ul class="doc-list">${documents.map(
        (f) => html`<li><a href="${fileUrl(f)}" download>${f.name}</a> <span class="muted small">${formatSize(f.sizeBytes)} · ${from(f)}</span></li>`,
      )}</ul>`
    : ''
}
${!photos.length && !documents.length ? html`<p class="muted">No photos or documents yet.</p>` : ''}
<form method="post" action="${base}/files#files" enctype="multipart/form-data" class="upload-form" data-max-bytes="${config.MAX_UPLOAD_BYTES}" data-max-files="${MAX_FILES_PER_UPLOAD}">
${csrf}
${
  o.uploadErrors?.length
    ? html`<div class="alert alert-error" role="alert" id="upload-error"><p>Some files weren't added:</p><ul>${o.uploadErrors.map(
        (e) => html`<li>${e.name ? html`<strong>${e.name}</strong>: ` : ''}${e.message}</li>`,
      )}</ul></div>`
    : ''
}
<label class="field" for="upload"><span>Add photos or documents</span>
<input type="file" id="upload" name="files" multiple accept="${UPLOAD_ACCEPT}" required${o.uploadErrors?.length ? raw(' aria-describedby="upload-error"') : ''}>
</label>
<p class="hint">Photos, short videos (MP4, MOV), PDFs, or Word and Excel documents, up to ${maxMb} MB each and ${MAX_FILES_PER_UPLOAD} at a time.</p>
<p class="file-summary" data-file-summary aria-live="polite" hidden></p>
<button type="submit" class="btn btn-secondary" data-busy-label="Uploading…">Upload</button>
</form>
</section>
<p class="small muted private-note">This page is private to you. Please don't share its link.</p>
</div>`;
  }

  // --- request helpers ---

  function readDevice(req: FastifyRequest): string | undefined {
    const signed = req.cookies[DEVICE_COOKIE];
    if (!signed) return undefined;
    const r = req.unsignCookie(signed);
    return r.valid && r.value && DEVICE_ID_RE.test(r.value) ? r.value : undefined;
  }

  const setDevice = (reply: FastifyReply, deviceId: string): void => {
    reply.setCookie(DEVICE_COOKIE, deviceId, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
    });
  };

  const redirect = (reply: FastifyReply, url: string): FastifyReply => reply.redirect(url, 303);

  // Claim and device for a POST, or the response already sent.
  function resolvePost(req: FastifyRequest<TokenParams>, reply: FastifyReply): { claim: Claim; token: string; deviceId: string } | null {
    const { token } = req.params;
    const claim = services.tokens.claimForToken(token);
    if (!claim) {
      notFound(reply);
      return null;
    }
    const deviceId = readDevice(req);
    if (!deviceId) {
      formExpired(reply, token);
      return null;
    }
    return { claim, token, deviceId };
  }

  function flash(query: unknown): string | undefined {
    const q = (query ?? {}) as Record<string, unknown>;
    if (q.verified === '1') return "Thanks, this device is verified. You won't need a code here next time.";
    if (q.sent === '1') return "Your message has been sent. We'll reply here and let you know by email.";
    const n = typeof q.uploaded === 'string' && /^\d{1,2}$/.test(q.uploaded) ? Number(q.uploaded) : 0;
    if (n > 0 && n <= MAX_FILES_PER_UPLOAD) return `Thank you, ${n === 1 ? '1 file was' : `${n} files were`} added to your claim.`;
    return undefined;
  }

  // --- routes ---

  await app.register(
    async (portal) => {
      portal.addHook('onSend', async (_req, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Robots-Tag', 'noindex, nofollow');
        if (!reply.hasHeader('Content-Security-Policy')) {
          reply.header(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          );
        }
        return payload;
      });

      portal.setErrorHandler((err, req, reply) => {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        if (status === 429) {
          return sendHtml(
            reply,
            429,
            'Please wait a moment',
            notice('Please wait a moment', "You've tried that several times in a short while. Please wait a few minutes, then try again.", null),
          );
        }
        // Log the route pattern, never the URL: it carries the claim's private token.
        if (status >= 500) log.error({ route: req.routeOptions.url, err: (err instanceof Error ? err.message : String(err)).split('\n')[0] }, 'portal: request failed');
        const code = status >= 400 && status < 500 ? status : 500;
        return sendHtml(
          reply,
          code,
          'Something went wrong',
          notice('Something went wrong', code === 500 ? 'Sorry, something went wrong on our side. Please try again in a few minutes.' : "Sorry, we couldn't handle that request. Please go back and try again.", null),
        );
      });

      portal.get<TokenParams>('/c/:token', async (req, reply) => {
        const { token } = req.params;
        const claim = services.tokens.claimForToken(token);
        if (!claim) return notFound(reply);
        let deviceId = readDevice(req);
        if (deviceId && auth.isDeviceTrusted(claim, deviceId)) {
          setDevice(reply, deviceId); // keeps an active device's cookie from expiring
          return sendHtml(reply, 200, `Claim ${claim.claimNumber}`, claimView(claim, token, deviceId, { notice: flash(req.query) }));
        }
        if (!deviceId) {
          // Needed for the CSRF token on the code form. Setting it sends nothing.
          deviceId = auth.newDeviceId();
          setDevice(reply, deviceId);
        }
        const q = (req.query ?? {}) as Record<string, unknown>;
        const stage: VerifyStage = q.code === 'sent' || q.code === 'enter' ? 'code' : 'start';
        return sendHtml(reply, 200, 'Open your claim', verifyView(claim, token, deviceId, stage));
      });

      portal.post<TokenParams>('/c/:token/code', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
        const r = resolvePost(req, reply);
        if (!r) return reply;
        const { claim, token, deviceId } = r;
        if (!auth.checkCsrf(deviceId, claim.itemId, field(req.body, '_csrf'))) return formExpired(reply, token);
        if (auth.isDeviceTrusted(claim, deviceId)) return redirect(reply, `/c/${token}`);
        if (!claim.email) return sendHtml(reply, 200, 'Open your claim', verifyView(claim, token, deviceId, 'start'));
        let sent: boolean;
        try {
          ({ sent } = await auth.sendLoginCode(claim, deviceId));
        } catch {
          return sendHtml(
            reply,
            503,
            'Open your claim',
            verifyView(claim, token, deviceId, 'start', { kind: 'error', text: "We couldn't send the email just now. Please try again in a few minutes." }),
          );
        }
        if (sent) return redirect(reply, `/c/${token}?code=sent`);
        return sendHtml(
          reply,
          429,
          'Enter your code',
          verifyView(claim, token, deviceId, 'code', {
            kind: 'error',
            text: "You've asked for several codes in a short time. Please use the most recent code we emailed you, or wait 15 minutes and ask for a new one.",
          }),
        );
      });

      portal.post<TokenParams>('/c/:token/verify', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
        const r = resolvePost(req, reply);
        if (!r) return reply;
        const { claim, token, deviceId } = r;
        if (!auth.checkCsrf(deviceId, claim.itemId, field(req.body, '_csrf'))) return formExpired(reply, token);
        if (auth.isDeviceTrusted(claim, deviceId)) return redirect(reply, `/c/${token}`);
        const result = auth.verifyLoginCode(claim, deviceId, field(req.body, 'code') ?? '', req.headers['user-agent']);
        if (result === 'ok') {
          setDevice(reply, deviceId);
          return redirect(reply, `/c/${token}?verified=1`);
        }
        if (result === 'locked') {
          return sendHtml(
            reply,
            429,
            'Open your claim',
            verifyView(claim, token, deviceId, 'locked', { kind: 'error', text: 'Too many incorrect tries. Please ask for a new code.' }),
          );
        }
        const text =
          result === 'expired'
            ? 'That code has expired or been replaced by a newer one. Please use the latest code we sent, or ask for a new one.'
            : "That code isn't right. Please check the email and try again.";
        return sendHtml(reply, 400, 'Enter your code', verifyView(claim, token, deviceId, 'code', { kind: 'error', text }));
      });

      portal.post<TokenParams>('/c/:token/messages', { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (req, reply) => {
        const r = resolvePost(req, reply);
        if (!r) return reply;
        const { claim, token, deviceId } = r;
        if (!auth.isDeviceTrusted(claim, deviceId)) return needsVerification(reply, token);
        if (!auth.checkCsrf(deviceId, claim.itemId, field(req.body, '_csrf'))) return formExpired(reply, token);
        const text = field(req.body, 'message') ?? '';
        try {
          services.messaging.postFromPortal(claim, text);
        } catch (err) {
          if (!(err instanceof ClaimantInputError)) throw err;
          return sendHtml(
            reply,
            400,
            `Claim ${claim.claimNumber}`,
            claimView(claim, token, deviceId, { messageError: err.message, draft: text.slice(0, MAX_MESSAGE_CHARS * 2) }),
          );
        }
        return redirect(reply, `/c/${token}?sent=1#messages`);
      });

      portal.post<TokenParams>('/c/:token/files', { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (req, reply) => {
        const r = resolvePost(req, reply);
        if (!r) return reply;
        const { claim, token, deviceId } = r;
        if (!auth.isDeviceTrusted(claim, deviceId)) return needsVerification(reply, token);
        if (!req.isMultipart()) return formExpired(reply, token);

        const maxMb = Math.floor(config.MAX_UPLOAD_BYTES / (1024 * 1024));
        const errors: Array<{ name: string | null; message: string }> = [];
        let csrfOk = false;
        let added = 0;
        let chosen = 0;
        try {
          for await (const part of req.parts()) {
            if (part.type === 'field') {
              if (part.fieldname === '_csrf' && !csrfOk) {
                csrfOk = auth.checkCsrf(deviceId, claim.itemId, typeof part.value === 'string' ? part.value : undefined);
                if (!csrfOk) break;
              }
              continue;
            }
            // Our form puts the CSRF field first, so no file is read before it is checked.
            if (!csrfOk) break;
            if (!part.filename) {
              part.file.resume(); // the empty part a browser sends when no file is chosen
              continue;
            }
            chosen++;
            const name = part.filename.slice(0, 120);
            let data: Buffer;
            try {
              data = await part.toBuffer();
            } catch (err) {
              if (errorCode(err) !== 'FST_REQ_FILE_TOO_LARGE') throw err;
              errors.push({ name, message: `This file is larger than ${maxMb} MB.` });
              continue;
            }
            try {
              await services.files.addClaimantUpload(claim, { name: part.filename, mimeType: part.mimetype, data });
              added++;
            } catch (err) {
              if (!(err instanceof ClaimantInputError)) throw err;
              errors.push({ name, message: err.message });
            }
          }
        } catch (err) {
          const code = errorCode(err);
          // A too-large file was already reported where it was read; the parser re-raises it at the end.
          if (code === 'FST_FILES_LIMIT') errors.push({ name: null, message: `Please add up to ${MAX_FILES_PER_UPLOAD} files at a time.` });
          else if (code !== 'FST_REQ_FILE_TOO_LARGE') throw err;
        }
        if (!csrfOk) return formExpired(reply, token);
        if (!chosen && !errors.length) errors.push({ name: null, message: 'Please choose at least one photo or document to upload.' });
        if (!errors.length) return redirect(reply, `/c/${token}?uploaded=${added}#files`);
        const fresh = repo.getClaim(claim.itemId) ?? claim;
        return sendHtml(
          reply,
          added ? 200 : 400,
          `Claim ${claim.claimNumber}`,
          claimView(fresh, token, deviceId, {
            uploadErrors: errors,
            notice: added ? `${added === 1 ? '1 file was' : `${added} files were`} added to your claim.` : undefined,
          }),
        );
      });

      portal.get<{ Params: { token: string; fileId: string } }>('/c/:token/files/:fileId', async (req, reply) => {
        const { token, fileId } = req.params;
        const claim = services.tokens.claimForToken(token);
        if (!claim) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        if (!auth.isDeviceTrusted(claim, readDevice(req))) {
          return reply.code(403).type('text/plain; charset=utf-8').send('Please open your claim link to verify this device.');
        }
        const file = /^\d{1,15}$/.test(fileId) ? repo.getFile(Number(fileId)) : null;
        if (!file || file.itemId !== claim.itemId) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        let data: Buffer;
        try {
          data = await services.files.read(file);
        } catch (err) {
          log.warn({ itemId: claim.itemId, fileId: file.id, err: (err instanceof Error ? err.message : String(err)).split('\n')[0] }, 'portal: cached file unavailable');
          return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        }
        const inline = isInlineImage(file);
        return reply
          .code(200)
          .header('Content-Type', inline ? file.mimeType.trim().toLowerCase() : downloadType(file.mimeType))
          .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', file.name))
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
          .header('Cross-Origin-Resource-Policy', 'same-origin')
          .send(data);
      });
    },
    {
      // The URL carries the claim's private token: keep per-request logs (info) out,
      // and redact the URL from anything that does get logged.
      logLevel: 'warn',
      logSerializers: { req: (r: { method?: string }) => `${r.method ?? ''} /c/[redacted]` },
    },
  );
}
