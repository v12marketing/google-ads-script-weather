import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewClaim } from '../src/db/repo.js';
import { JOB } from '../src/services/contracts.js';
import { buildApp } from '../src/web/app.js';
import { contentDisposition, DEVICE_COOKIE } from '../src/web/routes/portal.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

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
