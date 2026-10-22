import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NewClaim } from '../src/db/repo.js';
import { JOB } from '../src/services/contracts.js';
import { buildApp } from '../src/web/app.js';
import { MAX_CLAIMANT_FILES_PER_CLAIM } from '../src/services/files.js';
import { ContactConflictError } from '../src/services/notifier.js';
import { contentDisposition, DEVICE_COOKIE, MAX_PORTAL_MESSAGES_PER_DAY, MAX_UPLOAD_REQUEST_BYTES } from '../src/web/routes/portal.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

let nextItem = 7000;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b00000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function makeClaim(env: TestEnv, o: Partial<NewClaim> = {}) {
  const { tokens } = env.ctx.services;
  return env.ctx.repo.createClaim(
    {
      itemId: String(nextItem++),
      claimantName: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      statusKey: 'received',
      statusLabel: 'New',
      amountClaimed: 1250,
      receivedAt: new Date().toISOString(),
      ...o,
    },
    (id, v) => tokens.tokenHash(tokens.portalToken(id, v)),
  ).claim;
}

async function setup(o: Partial<NewClaim> = {}, envOpts: Parameters<typeof makeTestEnv>[0] = {}) {
  const env = makeTestEnv(envOpts);
  const claim = makeClaim(env, o);
  const app = await buildApp(env.ctx);
  apps.push(app);
  const token = env.ctx.services.tokens.portalToken(claim.itemId, claim.tokenVersion);
  return { env, app, claim, token, url: `/c/${token}` };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

function multipart(parts: Array<{ name: string; value?: string; filename?: string; type?: string; data?: Buffer }>) {
  const boundary = `----hdc${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const head =
      p.filename !== undefined
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}\r\n\r\n`
        : `Content-Disposition: form-data; name="${p.name}"\r\n\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${head}`), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const csrfFrom = (body: string): string => {
  const m = body.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('no CSRF field on the page');
  return m[1]!;
};

interface SetCookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  sameSite?: string;
  path?: string;
  maxAge?: number;
  secure?: boolean;
}
const deviceCookie = (res: { cookies: unknown[] }) => (res.cookies as SetCookie[]).find((c) => c.name === DEVICE_COOKIE);

const lastCode = (env: TestEnv): string => {
  const m = env.highlevel.emails.at(-1)?.text.match(/^(\d{6})$/m);
  if (!m) throw new Error('no login code email');
  return m[1]!;
};

const get = (t: Setup, url: string, cookie?: string) =>
  t.app.inject({ method: 'GET', url, cookies: cookie ? { [DEVICE_COOKIE]: cookie } : {} });

const post = (t: Setup, url: string, cookie: string | undefined, body: ReturnType<typeof form> | ReturnType<typeof multipart>) =>
  t.app.inject({ method: 'POST', url, cookies: cookie ? { [DEVICE_COOKIE]: cookie } : {}, ...body });

// Runs the code flow; returns the trusted device cookie and the claim page's CSRF token.
async function verifyDevice(t: Setup): Promise<{ cookie: string; csrf: string }> {
  const first = await get(t, t.url);
  const cookie = deviceCookie(first)!.value;
  const csrf = csrfFrom(first.body);
  expect((await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }))).statusCode).toBe(303);
  const res = await post(t, `${t.url}/verify`, cookie, form({ _csrf: csrf, code: lastCode(t.env) }));
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe(`${t.url}?verified=1`);
  const page = await get(t, t.url, cookie);
  return { cookie, csrf: csrfFrom(page.body) };
}

// The progress tracker's steps as [label, state].
const trackerSteps = (body: string): string[][] =>
  [...body.matchAll(/<li class="step (\w+)"[^>]*><span class="dot" aria-hidden="true"><\/span><span class="step-label">([^<]+)<\/span>/g)].map((m) => [m[2]!, m[1]!]);

function addFile(t: Setup, o: { itemId?: string; name: string; mimeType: string; data: Buffer; source?: 'team' | 'claimant' }) {
  const storageKey = `${o.itemId ?? t.claim.itemId}/test-${Math.random().toString(16).slice(2)}`;
  t.env.store.files.set(storageKey, o.data);
  return t.env.ctx.repo.addFile({
    itemId: o.itemId ?? t.claim.itemId,
    source: o.source ?? 'team',
    columnId: null,
    mondayAssetId: null,
    name: o.name,
    mimeType: o.mimeType,
    sizeBytes: o.data.length,
    storageKey,
  })!;
}

describe('portal: link and device verification', () => {
  it('shows a not-found page for an unknown token', async () => {
    const t = await setup();
    for (const url of ['/c/not-a-real-token', `/c/${'A'.repeat(43)}`]) {
      const res = await get(t, url);
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('This link isn&#39;t valid anymore');
      expect(res.body).toContain('href="/find-my-claim"');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toContain('noindex');
    }
  });

  it('asks an unknown browser to verify, without sending a code or showing the claim', async () => {
    const t = await setup();
    t.env.ctx.repo.addMessage({ itemId: t.claim.itemId, direction: 'to_claimant', channel: 'monday', body: 'Secret message for Jane' });
    const res = await get(t, t.url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.body).toContain('name="robots" content="noindex');
    expect(res.body).toContain('Email me a code');
    expect(res.body).toContain(`action="${t.url}/code"`);
    expect(res.body).toContain('j***@e***.com');
    expect(res.body).not.toContain('jane@example.com');
    expect(res.body).not.toContain(t.claim.claimNumber);
    expect(res.body).not.toContain('Secret message');
    // Link scanners prefetch: a GET must never send a code.
    expect(t.env.highlevel.emails).toHaveLength(0);
    expect(t.env.ctx.db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()).toEqual({ n: 0 });

    const c = deviceCookie(res)!;
    expect(c).toBeDefined();
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.path).toBe('/');
    expect(c.maxAge).toBe(400 * 24 * 60 * 60);
    expect(c.secure).toBeFalsy();
  });

  it('verifies the device with an emailed code and then shows the claim', async () => {
    const t = await setup();
    const first = await get(t, t.url);
    const cookie = deviceCookie(first)!.value;
    const csrf = csrfFrom(first.body);

    const sent = await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(`${t.url}?code=sent`);
    expect(t.env.highlevel.emails).toHaveLength(1);
    expect(t.env.highlevel.sms).toHaveLength(0);
    const code = lastCode(t.env);

    const entry = await get(t, `${t.url}?code=sent`, cookie);
    expect(entry.body).toContain(`action="${t.url}/verify"`);
    expect(entry.body).toContain('inputmode="numeric"');
    expect(entry.body).toContain('autocomplete="one-time-code"');
    expect(entry.body).toContain('Send a new code');

    const wrong = await post(t, `${t.url}/verify`, cookie, form({ _csrf: csrf, code: code === '000000' ? '111111' : '000000' }));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('That code isn&#39;t right');

    const ok = await post(t, `${t.url}/verify`, cookie, form({ _csrf: csrf, code }));
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe(`${t.url}?verified=1`);
    const set = deviceCookie(ok)!;
    expect(set.value).toBe(cookie);
    expect(set.httpOnly).toBe(true);

    const page = await get(t, `${t.url}?verified=1`, cookie);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(t.claim.claimNumber);
    expect(page.body).toContain('this device is verified');
    // Another browser still has to verify.
    expect((await get(t, t.url)).body).not.toContain(t.claim.claimNumber);
  });

  it('reports an expired code and locks after 5 wrong tries', async () => {
    const t = await setup();
    const first = await get(t, t.url);
    const cookie = deviceCookie(first)!.value;
    const csrf = csrfFrom(first.body);
    await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    const code = lastCode(t.env);

    t.env.ctx.db.prepare('UPDATE login_codes SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    const expired = await post(t, `${t.url}/verify`, cookie, form({ _csrf: csrf, code }));
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toContain('expired');

    await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    const fresh = lastCode(t.env);
    const wrong = fresh === '999999' ? '888888' : '999999';
    for (let i = 0; i < 4; i++) expect((await post(t, `${t.url}/verify`, cookie, form({ _csrf: csrf, code: wrong }))).statusCode).toBe(400);
    const locked = await post(t, `${t.url}/verify`, cookie, form({ _csrf: csrf, code: wrong }));
    expect(locked.statusCode).toBe(429);
    expect(locked.body).toContain('Too many incorrect tries');
    expect((await post(t, `${t.url}/verify`, cookie, form({ _csrf: csrf, code: fresh }))).statusCode).toBe(429);
    expect((await get(t, t.url, cookie)).body).not.toContain(t.claim.claimNumber);
  });

  it('rate-limits code requests per claim and per IP', async () => {
    const t = await setup();
    const first = await get(t, t.url);
    const cookie = deviceCookie(first)!.value;
    const csrf = csrfFrom(first.body);
    for (let i = 0; i < 3; i++) expect((await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }))).statusCode).toBe(303);
    const limited = await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toContain('several codes');
    expect(t.env.highlevel.emails).toHaveLength(3);
    await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    const ipLimited = await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    expect(ipLimited.statusCode).toBe(429);
    expect(ipLimited.headers['content-type']).toContain('text/html');
    expect(ipLimited.headers['cache-control']).toBe('no-store');
  });

  it("says when the claim's daily code allowance is used up, instead of pointing to a code this browser never got", async () => {
    const t = await setup();
    const insert = t.env.ctx.db.prepare(`INSERT INTO login_codes (item_id, device_hash, code_hash, expires_at, created_at) VALUES (?, ?, 'x', ?, ?)`);
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    for (let i = 0; i < 20; i++) insert.run(t.claim.itemId, `other-browser-${i}`, hourAgo, hourAgo);
    const first = await get(t, t.url);
    const res = await post(t, `${t.url}/code`, deviceCookie(first)!.value, form({ _csrf: csrfFrom(first.body) }));
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('as many sign-in codes for this claim as we can today');
    expect(res.body).not.toContain('most recent code');
    expect(t.env.highlevel.emails).toHaveLength(0);
  });

  it('points a browser that hit its own limit to the code it asked for here', async () => {
    const t = await setup();
    const first = await get(t, t.url);
    const cookie = deviceCookie(first)!.value;
    const csrf = csrfFrom(first.body);
    for (let i = 0; i < 3; i++) await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    const res = await post(t, `${t.url}/code`, cookie, form({ _csrf: csrf }));
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('most recent code you asked for here');
  });

  it("explains that a code can't be emailed while the claim's contact needs the team", async () => {
    const t = await setup();
    vi.spyOn(t.env.ctx.services.auth, 'sendLoginCode').mockRejectedValueOnce(new ContactConflictError('conflict'));
    const first = await get(t, t.url);
    const res = await post(t, `${t.url}/code`, deviceCookie(first)!.value, form({ _csrf: csrfFrom(first.body) }));
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('can&#39;t email a code for this claim just now');
    expect(res.body).not.toContain('try again in a few minutes');
  });

  it('tells a browser that a code was asked for on another one', async () => {
    const t = await setup();
    const computer = await get(t, t.url);
    await post(t, `${t.url}/code`, deviceCookie(computer)!.value, form({ _csrf: csrfFrom(computer.body) }));
    const code = lastCode(t.env);
    // The claimant opens the claim on their phone and types the code there.
    const phone = await get(t, `${t.url}?code=enter`);
    const res = await post(t, `${t.url}/verify`, deviceCookie(phone)!.value, form({ _csrf: csrfFrom(phone.body), code }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('asked for on a different browser or device');
    expect(res.body).not.toContain('expired');
  });

  it('rejects code requests without a valid CSRF token or device cookie', async () => {
    const t = await setup();
    const first = await get(t, t.url);
    const cookie = deviceCookie(first)!.value;
    expect((await post(t, `${t.url}/code`, cookie, form({ _csrf: 'forged' }))).statusCode).toBe(403);
    expect((await post(t, `${t.url}/code`, cookie, form({}))).statusCode).toBe(403);
    expect((await post(t, `${t.url}/code`, undefined, form({ _csrf: csrfFrom(first.body) }))).statusCode).toBe(403);
    // A tampered cookie isn't accepted either.
    expect((await post(t, `${t.url}/code`, `${cookie}x`, form({ _csrf: csrfFrom(first.body) }))).statusCode).toBe(403);
    expect(t.env.highlevel.emails).toHaveLength(0);
  });

  it('explains when the claim has no email address', async () => {
    const t = await setup({ email: null });
    const res = await get(t, t.url);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("We don't have an email address");
    expect(res.body).not.toContain('Email me a code');
  });

  it('rotating the token kills the old link and every trusted device', async () => {
    const t = await setup();
    const { cookie } = await verifyDevice(t);
    const { tokens } = t.env.ctx.services;
    t.env.ctx.repo.updateClaim(t.claim.itemId, { tokenVersion: 2, tokenHash: tokens.tokenHash(tokens.portalToken(t.claim.itemId, 2)) });

    expect((await get(t, t.url, cookie)).statusCode).toBe(404);
    const newUrl = `/c/${tokens.portalToken(t.claim.itemId, 2)}`;
    const res = await get(t, newUrl, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Email me a code');
    expect(res.body).not.toContain(t.claim.claimNumber);
  });
});

describe('portal: claim page', () => {
  it('shows status, next steps, progress and the message thread, escaped', async () => {
    const t = await setup({ statusKey: 'more_info_needed', statusLabel: 'More info needed' });
    const { repo } = t.env.ctx;
    repo.addMessage({ itemId: t.claim.itemId, direction: 'system', channel: 'monday', body: 'Claim received' });
    repo.addMessage({ itemId: t.claim.itemId, direction: 'to_claimant', channel: 'monday', body: 'Please send a photo of the box <b>label</b>' });
    repo.addMessage({ itemId: t.claim.itemId, direction: 'from_claimant', channel: 'portal', body: '<script>alert(1)</script>' });
    const { cookie } = await verifyDevice(t);

    const res = await get(t, t.url, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.body).toContain('/static/portal.css');
    expect(res.body).toContain('/static/portal.js');
    expect(res.body).toContain(t.claim.claimNumber);
    expect(res.body).toContain('>More info needed<');
    expect(res.body).toContain('What happens next');
    expect(res.body).toContain(t.env.ctx.services.templates.get('more_info_needed').portalText.slice(0, 40));
    expect(res.body).toMatch(/class="step current" aria-current="step">.*Under review/);
    expect(res.body).toContain('msg-event');
    expect(res.body).toContain('Claims team');
    expect(res.body).toContain('Please send a photo of the box &lt;b&gt;label&lt;/b&gt;');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).not.toContain('<script>alert(1)');
    expect(res.body).toContain(`action="${t.url}/messages#messages"`);
  });

  it('falls back to "Received" and hides internal board labels', async () => {
    const t = await setup({ statusKey: null, statusLabel: null });
    const { cookie } = await verifyDevice(t);
    expect((await get(t, t.url, cookie)).body).toContain('>Received<');
    t.env.ctx.repo.updateClaim(t.claim.itemId, { statusKey: 'under_review', statusLabel: 'Waiting on carrier (internal)' });
    const body = (await get(t, t.url, cookie)).body;
    expect(body).toContain('>Under review<');
    expect(body).not.toContain('Waiting on carrier');
  });

  it('shows the settlement offer with the amount sent', async () => {
    const t = await setup({ statusKey: 'settlement_offered', statusLabel: 'Settlement offered' });
    t.env.ctx.repo.updateClaim(t.claim.itemId, { settlementAmount: 1500, settlementAmountSent: 1250.5, settlementSentAt: new Date().toISOString() });
    const { cookie } = await verifyDevice(t);
    const body = (await get(t, t.url, cookie)).body;
    expect(body).toContain('Your settlement offer');
    expect(body).toContain('$1,250.50');
    expect(body).not.toContain('$1,500.00');
    expect(body).toContain('it comes from Home Delivery Claims');
    expect(body).not.toContain('secure payment form');
    // No signing link from HighLevel yet: no button, and no promise of one.
    expect(body).not.toContain('Open the settlement document');
    expect(body).not.toContain('open it from this page');
  });

  it("links the claimant's settlement document once HighLevel has given its signing link", async () => {
    const t = await setup({ statusKey: 'settlement_offered', statusLabel: 'Settlement offered' });
    const link = 'https://link.example.com/documents/v1/abc?x=1&y=2';
    t.env.ctx.repo.updateClaim(t.claim.itemId, { settlementAmountSent: 900, settlementSentAt: new Date().toISOString(), settlementSignUrl: link });
    const { cookie } = await verifyDevice(t);
    const body = (await get(t, t.url, cookie)).body;
    expect(body).toContain(
      '<a class="btn btn-primary" href="https://link.example.com/documents/v1/abc?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">Open the settlement document</a>',
    );

    // Signed, or no longer open: no link.
    t.env.ctx.repo.updateClaim(t.claim.itemId, { settlementSentAt: null });
    expect((await get(t, t.url, cookie)).body).not.toContain('Open the settlement document');
  });

  it('links the payment form after signing, then shows payment details received', async () => {
    const t = await setup({ statusKey: 'settlement_signed', statusLabel: 'Settlement signed' });
    t.env.ctx.repo.updateClaim(t.claim.itemId, { settlementSignedAt: new Date().toISOString() });
    const { cookie } = await verifyDevice(t);
    const body = (await get(t, t.url, cookie)).body;
    const formUrl = t.env.ctx.services.payment.paymentFormUrl(t.env.ctx.repo.getClaim(t.claim.itemId)!);
    expect(body).toContain(`href="${formUrl.replace(/&/g, '&amp;')}" target="_blank" rel="noopener noreferrer"`);
    expect(body).toContain('direct deposit');
    expect(body).toContain('mailed check');
    expect(body).not.toContain('Payment details received');

    t.env.ctx.repo.updateClaim(t.claim.itemId, { paymentDetailsReceivedAt: new Date().toISOString() });
    const after = (await get(t, t.url, cookie)).body;
    expect(after).toContain('Payment details received');
    expect(after).not.toContain('Open the secure payment form');
  });

  it('shows denied claims distinctly', async () => {
    const t = await setup({ statusKey: 'denied', statusLabel: 'Denied' });
    const { cookie } = await verifyDevice(t);
    const body = (await get(t, t.url, cookie)).body;
    expect(body).toContain('tracker-denied');
    expect(body).toContain('badge badge-denied');
    expect(body).not.toContain('>Settlement<');
  });

  it('never shows settlement or payment as done on a claim closed without a settlement', async () => {
    const t = await setup({ statusKey: 'closed', statusLabel: 'Closed' });
    const { cookie } = await verifyDevice(t);
    const body = (await get(t, t.url, cookie)).body;
    expect(trackerSteps(body)).toEqual([
      ['Received', 'done'],
      ['Under review', 'done'],
      ['Closed', 'done'],
    ]);
    expect(body).not.toContain('>Settlement<');
    expect(body).not.toContain('>Payment<');
  });

  it('shows a claim that was denied and then closed as not approved', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    await env.ctx.services.intake.handleItemCreated(item.id);
    for (const [label, eventId] of [['Denied', 'evt-1'], ['Closed', 'evt-2']] as const) {
      env.monday.setText(item.id, env.board.columns.status, label, 'status');
      await env.ctx.services.status.handleStatusChanged(item.id, label, eventId);
    }
    const claim = env.ctx.repo.getClaim(item.id)!;
    expect(claim.statusKey).toBe('closed');
    const app = await buildApp(env.ctx);
    apps.push(app);
    const token = env.ctx.services.tokens.portalToken(claim.itemId, claim.tokenVersion);
    const t: Setup = { env, app, claim, token, url: `/c/${token}` };
    const { cookie } = await verifyDevice(t);

    const body = (await get(t, t.url, cookie)).body;
    expect(trackerSteps(body)).toEqual([
      ['Received', 'done'],
      ['Under review', 'done'],
      ['Not approved', 'denied'],
      ['Closed', 'done'],
    ]);
    expect(body).toContain('tracker-denied');
  });

  it('shows settlement and payment done on a claim closed after it was settled and paid', async () => {
    const t = await setup({ statusKey: 'closed', statusLabel: 'Closed' });
    const { repo } = t.env.ctx;
    repo.updateClaim(t.claim.itemId, { settlementSignedAt: new Date().toISOString() });
    const { cookie } = await verifyDevice(t);
    // Signed, but no sign of payment (no payment details, never "Payment sent").
    expect(trackerSteps((await get(t, t.url, cookie)).body)).toEqual([
      ['Received', 'done'],
      ['Under review', 'done'],
      ['Settlement', 'done'],
      ['Payment', 'todo'],
      ['Closed', 'done'],
    ]);

    repo.addMessage({ itemId: t.claim.itemId, direction: 'system', channel: 'monday', body: 'Status updated: Payment sent' });
    repo.addMessage({ itemId: t.claim.itemId, direction: 'system', channel: 'monday', body: 'Status updated: Closed' });
    const paid = trackerSteps((await get(t, t.url, cookie)).body);
    expect(paid.map(([, state]) => state)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('shows settlement and payment done on a closed claim whose signature the team recorded on the board', async () => {
    const t = await setup({ statusKey: 'closed', statusLabel: 'Closed' });
    const { repo } = t.env.ctx;
    for (const label of ['Under review', 'Settlement offered', 'Settlement signed', 'Payment sent', 'Closed']) {
      repo.addMessage({ itemId: t.claim.itemId, direction: 'system', channel: 'monday', body: `Status updated: ${label}` });
    }
    expect(repo.getClaim(t.claim.itemId)!.settlementSignedAt).toBeNull();
    const { cookie } = await verifyDevice(t);
    expect(trackerSteps((await get(t, t.url, cookie)).body)).toEqual([
      ['Received', 'done'],
      ['Under review', 'done'],
      ['Settlement', 'done'],
      ['Payment', 'done'],
      ['Closed', 'done'],
    ]);
  });

  it('shows the settlement offer only once a document for a real amount has been sent', async () => {
    const t = await setup({ statusKey: 'settlement_offered', statusLabel: 'Settlement offered' });
    const { repo } = t.env.ctx;
    const offeredText = 'sent you a settlement offer to review';
    repo.updateClaim(t.claim.itemId, { settlementAmount: 0 });
    const { cookie } = await verifyDevice(t);

    // No document went out: the amount was 0, or sending was blocked.
    for (const amount of [0, 2000]) {
      repo.updateClaim(t.claim.itemId, { settlementAmount: amount });
      const body = (await get(t, t.url, cookie)).body;
      expect(body).toContain('>Settlement offered<');
      expect(body).not.toContain('Your settlement offer');
      expect(body).not.toContain('$0.00');
      expect(body).not.toContain('$2,000.00');
      expect(body).not.toContain(offeredText);
      expect(body).toContain('preparing your settlement offer');
    }

    repo.updateClaim(t.claim.itemId, { settlementSentAt: new Date().toISOString(), settlementAmountSent: 2000 });
    const sent = (await get(t, t.url, cookie)).body;
    expect(sent).toContain('Your settlement offer');
    expect(sent).toContain('$2,000.00');
    expect(sent).toContain(offeredText);

    // The document was declined or withdrawn in HighLevel.
    repo.updateClaim(t.claim.itemId, { settlementSentAt: null });
    const withdrawn = (await get(t, t.url, cookie)).body;
    expect(withdrawn).not.toContain('Your settlement offer');
    expect(withdrawn).toContain('preparing your settlement offer');
  });
});

describe('portal: messages', () => {
  it('stores a message and queues it for Monday, then redirects', async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const res = await post(t, `${t.url}/messages`, cookie, form({ _csrf: csrf, message: 'Here is the box label.' }));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${t.url}?sent=1#messages`);
    const msgs = t.env.ctx.repo.listMessages(t.claim.itemId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'from_claimant', channel: 'portal', body: 'Here is the box label.' });
    const jobs = t.env.ctx.jobs.list().filter((j) => j.type === JOB.portalMessageToMonday);
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ messageId: msgs[0]!.id });

    const page = await get(t, `${t.url}?sent=1`, cookie);
    expect(page.body).toContain('Your message has been sent');
    expect(page.body).toContain('Here is the box label.');
  });

  it('shows validation errors and keeps the draft', async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const res = await post(t, `${t.url}/messages`, cookie, form({ _csrf: csrf, message: '   ' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('alert alert-error');
    expect(t.env.ctx.repo.listMessages(t.claim.itemId)).toHaveLength(0);

    const long = 'x'.repeat(6000);
    const tooLong = await post(t, `${t.url}/messages`, cookie, form({ _csrf: csrf, message: long }));
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).toContain(long);
  });

  it('limits the messages one claim can send from the page in a day', async () => {
    const t = await setup();
    const { repo, jobs } = t.env.ctx;
    const itemId = t.claim.itemId;
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < MAX_PORTAL_MESSAGES_PER_DAY; i++) {
      repo.addMessage({ itemId, direction: 'from_claimant', channel: 'portal', body: `old ${i}`, createdAt: yesterday });
    }
    for (let i = 0; i < MAX_PORTAL_MESSAGES_PER_DAY - 1; i++) repo.addMessage({ itemId, direction: 'from_claimant', channel: 'portal', body: `today ${i}` });
    repo.addMessage({ itemId, direction: 'from_claimant', channel: 'email', body: 'An email reply' }); // not from the page
    const { cookie, csrf } = await verifyDevice(t);

    expect((await post(t, `${t.url}/messages`, cookie, form({ _csrf: csrf, message: 'The last one for today' }))).statusCode).toBe(303);
    const res = await post(t, `${t.url}/messages`, cookie, form({ _csrf: csrf, message: 'One more thing' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('a lot of messages today');
    expect(res.body).toContain('>One more thing</textarea>');
    expect(repo.listMessages(itemId).filter((m) => m.body === 'One more thing')).toEqual([]);
    expect(jobs.list().filter((j) => j.type === JOB.portalMessageToMonday)).toHaveLength(1);
  });

  it('rejects a bad CSRF token and untrusted devices', async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const forged = await post(t, `${t.url}/messages`, cookie, form({ _csrf: 'forged', message: 'hi' }));
    expect(forged.statusCode).toBe(403);
    // A token minted for another browser doesn't work with this one.
    const other = await get(t, t.url);
    const stranger = deviceCookie(other)!.value;
    expect((await post(t, `${t.url}/messages`, stranger, form({ _csrf: csrf, message: 'hi' }))).statusCode).toBe(403);
    expect((await post(t, `${t.url}/messages`, stranger, form({ _csrf: csrfFrom(other.body), message: 'hi' }))).statusCode).toBe(403);
    expect((await post(t, `${t.url}/messages`, undefined, form({ _csrf: csrf, message: 'hi' }))).statusCode).toBe(403);
    expect(t.env.ctx.repo.listMessages(t.claim.itemId)).toHaveLength(0);
  });
});

describe('portal: files', () => {
  it('accepts uploads and lists them as photos and documents', async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const res = await post(
      t,
      `${t.url}/files`,
      cookie,
      multipart([
        { name: '_csrf', value: csrf },
        { name: 'files', filename: 'box.png', type: 'image/png', data: PNG },
        { name: 'files', filename: 'receipt.pdf', type: 'application/pdf', data: PDF },
      ]),
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${t.url}?uploaded=2#files`);
    const files = t.env.ctx.repo.listFiles(t.claim.itemId);
    expect(files.map((f) => [f.name, f.source])).toEqual([
      ['box.png', 'claimant'],
      ['receipt.pdf', 'claimant'],
    ]);
    expect(t.env.ctx.jobs.list().filter((j) => j.type === JOB.uploadToMonday)).toHaveLength(2);

    const page = (await get(t, `${t.url}?uploaded=2`, cookie)).body;
    expect(page).toContain('2 files were added');
    expect(page).toContain(`<img src="${t.url}/files/${files[0]!.id}"`);
    expect(page).toContain(`href="${t.url}/files/${files[1]!.id}" download>receipt.pdf</a>`);
  });

  it('shows why a file was refused and keeps the ones that were fine', async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const res = await post(
      t,
      `${t.url}/files`,
      cookie,
      multipart([
        { name: '_csrf', value: csrf },
        { name: 'files', filename: 'evil.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') },
        { name: 'files', filename: 'box.png', type: 'image/png', data: PNG },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('alert alert-error');
    expect(res.body).toContain('<strong>evil.html</strong>');
    expect(res.body).toContain('1 file was added');
    expect(t.env.ctx.repo.listFiles(t.claim.itemId).map((f) => f.name)).toEqual(['box.png']);

    const none = await post(t, `${t.url}/files`, cookie, multipart([{ name: '_csrf', value: csrf }, { name: 'files', filename: '', data: Buffer.alloc(0) }]));
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain('Please choose at least one');
  });

  it('reports files over the size limit and too many files at once', async () => {
    const t = await setup({}, { config: { MAX_UPLOAD_BYTES: 1024 } });
    const { cookie, csrf } = await verifyDevice(t);
    const big = Buffer.concat([PNG, Buffer.alloc(2048)]);
    const res = await post(
      t,
      `${t.url}/files`,
      cookie,
      multipart([
        { name: '_csrf', value: csrf },
        { name: 'files', filename: 'huge.png', type: 'image/png', data: big },
        { name: 'files', filename: 'box.png', type: 'image/png', data: PNG },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<strong>huge.png</strong>: This file is larger than');
    expect(t.env.ctx.repo.listFiles(t.claim.itemId).map((f) => f.name)).toEqual(['box.png']);

    const many = Array.from({ length: 11 }, (_, i) => ({ name: 'files', filename: `p${i}.png`, type: 'image/png', data: PNG }));
    const tooMany = await post(t, `${t.url}/files`, cookie, multipart([{ name: '_csrf', value: csrf }, ...many]));
    expect(tooMany.body).toContain('Please add up to 10 files at a time');
    expect(t.env.ctx.repo.listFiles(t.claim.itemId)).toHaveLength(11);
  });

  it('states the upload limits on the form', async () => {
    const t = await setup();
    const { cookie } = await verifyDevice(t);
    const body = (await get(t, t.url, cookie)).body;
    expect(body).toContain('Up to 10 files at a time, 25 MB each and 100 MB in total.');
    expect(body).toContain(`data-claim-url="${t.url}" data-max-bytes="${25 * 1024 * 1024}" data-max-files="10" data-max-total="${MAX_UPLOAD_REQUEST_BYTES}"`);
    expect(body).toContain('aria-describedby="upload-hint"');
  });

  it('names each file that would take one upload over its total, and keeps the rest', async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const photo = Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)]); // under 25 MB each; five are over 100 MB
    const res = await post(
      t,
      `${t.url}/files`,
      cookie,
      multipart([
        { name: '_csrf', value: csrf },
        ...[1, 2, 3, 4, 5].map((i) => ({ name: 'files', filename: `photo${i}.png`, type: 'image/png', data: photo })),
        { name: 'files', filename: 'receipt.pdf', type: 'application/pdf', data: PDF },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('5 files were added');
    expect(res.body).toContain('<strong>photo5.png</strong>: One upload can be up to 100 MB in total');
    expect(t.env.ctx.repo.listFiles(t.claim.itemId).map((f) => f.name)).toEqual(['photo1.png', 'photo2.png', 'photo3.png', 'photo4.png', 'receipt.pdf']);
  });

  it("answers the page script's one-file uploads with JSON", async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const send = (file: { filename: string; type: string; data: Buffer }) => {
      const body = multipart([{ name: '_csrf', value: csrf }, { name: 'files', ...file }]);
      return t.app.inject({
        method: 'POST',
        url: `${t.url}/files`,
        cookies: { [DEVICE_COOKIE]: cookie },
        headers: { ...body.headers, accept: 'application/json' },
        payload: body.payload,
      });
    };

    const ok = await send({ filename: 'box.png', type: 'image/png', data: PNG });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ added: 1, errors: [] });

    const bad = await send({ filename: 'evil.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ added: 0, errors: [{ name: 'evil.html', message: expect.stringContaining("can't accept that type of file") }] });
    expect(t.env.ctx.repo.listFiles(t.claim.itemId).map((f) => f.name)).toEqual(['box.png']);
  });

  it("refuses files over the claim's allowance with a friendly message", async () => {
    const t = await setup();
    for (let i = 0; i < MAX_CLAIMANT_FILES_PER_CLAIM; i++) addFile(t, { name: `p${i}.png`, mimeType: 'image/png', data: PNG, source: 'claimant' });
    const { cookie, csrf } = await verifyDevice(t);
    const res = await post(t, `${t.url}/files`, cookie, multipart([{ name: '_csrf', value: csrf }, { name: 'files', filename: 'box.png', type: 'image/png', data: PNG }]));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(`<strong>box.png</strong>: Your claim already has ${MAX_CLAIMANT_FILES_PER_CLAIM} files from you`);
    expect(t.env.ctx.repo.listFiles(t.claim.itemId)).toHaveLength(MAX_CLAIMANT_FILES_PER_CLAIM);
  });

  it('refuses uploads without CSRF or from an untrusted device', async () => {
    const t = await setup();
    const { cookie, csrf } = await verifyDevice(t);
    const file = { name: 'files', filename: 'box.png', type: 'image/png', data: PNG };
    expect((await post(t, `${t.url}/files`, cookie, multipart([{ name: '_csrf', value: 'forged' }, file]))).statusCode).toBe(403);
    expect((await post(t, `${t.url}/files`, cookie, multipart([file, { name: '_csrf', value: csrf }]))).statusCode).toBe(403);
    const stranger = deviceCookie(await get(t, t.url))!.value;
    expect((await post(t, `${t.url}/files`, stranger, multipart([{ name: '_csrf', value: csrf }, file]))).statusCode).toBe(403);
    expect(t.env.ctx.repo.listFiles(t.claim.itemId)).toHaveLength(0);
  });

  it('serves files only to trusted devices, only for their claim, never inline unless a safe image', async () => {
    const t = await setup();
    const photo = addFile(t, { name: 'box.png', mimeType: 'image/png', data: PNG, source: 'claimant' });
    const doc = addFile(t, { name: 'Estimate é.pdf', mimeType: 'application/pdf', data: PDF });
    const svg = addFile(t, { name: 'x.svg', mimeType: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)"/>') });
    const other = makeClaim(t.env);
    const theirs = addFile(t, { itemId: other.itemId, name: 'theirs.png', mimeType: 'image/png', data: PNG });

    // Untrusted: nothing, not even for a real file id.
    const anon = await get(t, `${t.url}/files/${photo.id}`);
    expect(anon.statusCode).toBe(403);
    expect(anon.rawPayload.includes(PNG)).toBe(false);

    const { cookie } = await verifyDevice(t);
    const img = await get(t, `${t.url}/files/${photo.id}`, cookie);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toMatch(/^inline; filename="box.png"/);
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['cache-control']).toBe('no-store');
    expect(img.rawPayload.equals(PNG)).toBe(true);

    const pdf = await get(t, `${t.url}/files/${doc.id}`, cookie);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="Estimate _.pdf"; filename*=UTF-8''Estimate%20%C3%A9.pdf`);

    const s = await get(t, `${t.url}/files/${svg.id}`, cookie);
    expect(s.headers['content-type']).toBe('application/octet-stream');
    expect(s.headers['content-disposition']).toMatch(/^attachment;/);
    expect(s.headers['content-security-policy']).toContain('sandbox');

    expect((await get(t, `${t.url}/files/${theirs.id}`, cookie)).statusCode).toBe(404);
    expect((await get(t, `${t.url}/files/999999`, cookie)).statusCode).toBe(404);
    expect((await get(t, `${t.url}/files/abc`, cookie)).statusCode).toBe(404);

    // The claim page shows team documents and both sources' photos.
    const page = (await get(t, t.url, cookie)).body;
    expect(page).toContain('Estimate é.pdf');
    expect(page).toContain(`<img src="${t.url}/files/${photo.id}"`);
    expect(page).not.toContain('theirs.png');
  });

  it('encodes awkward file names safely', () => {
    expect(contentDisposition('attachment', 'a"b\\c;\r\n.pdf')).toBe(`attachment; filename="a_b_c___.pdf"; filename*=UTF-8''a%22b%5Cc%3B%0D%0A.pdf`);
    expect(contentDisposition('inline', "it's (1).png")).toBe(`inline; filename="it's (1).png"; filename*=UTF-8''it%27s%20%281%29.png`);
  });
});
