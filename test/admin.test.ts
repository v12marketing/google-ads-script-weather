import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nowIso } from '../src/db/index.js';
import type { AppConfig } from '../src/config.js';
import { PermanentJobError } from '../src/services/jobs.js';
import { adminCsrfToken, FailureLimiter, hashPassword, parseBasicAuth, verifyPassword } from '../src/web/admin-auth.js';
import { smsLength } from '../src/web/routes/admin.js';
import { buildApp } from '../src/web/app.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
let passwordHash = '';
beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function setup(config: Partial<AppConfig> = {}) {
  const env = makeTestEnv({ config: { ADMIN_PASSWORD_HASH: passwordHash, ...config } });
  const app = await buildApp(env.ctx);
  apps.push(app);
  const csrf = adminCsrfToken(env.config.APP_SECRET, env.config.ADMIN_USER);
  return { env, app, csrf };
}

const basic = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
const AUTH = () => ({ authorization: basic('admin', PASSWORD) });

const get = (app: FastifyInstance, url: string, headers: Record<string, string> = AUTH()) => app.inject({ method: 'GET', url, headers });
const postForm = (app: FastifyInstance, url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...AUTH(), ...headers },
  } as InjectOptions);

// A claim with a matching item on the fake board.
function makeClaim(env: TestEnv) {
  const item = addClaimItem(env);
  const { tokens } = env.ctx.services;
  const { claim } = env.ctx.repo.createClaim(
    {
      itemId: item.id,
      claimantName: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      statusKey: 'received',
      statusLabel: 'New',
      amountClaimed: 1250,
      receivedAt: nowIso(),
    },
    (id, v) => tokens.tokenHash(tokens.portalToken(id, v)),
  );
  return claim;
}

describe('admin-auth', () => {
  it('hashes in the scrypt$salt$hash format and verifies', async () => {
    expect(passwordHash).toMatch(/^scrypt\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(passwordHash.split('$')[2]!, 'base64')).toHaveLength(64);
    expect(await verifyPassword(PASSWORD, passwordHash)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, passwordHash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$unset$unset')).toBe(false);
    expect(await verifyPassword(PASSWORD, '')).toBe(false);
    expect(await hashPassword(PASSWORD)).not.toBe(passwordHash); // salted
  });

  it('parses Basic credentials, including colons in the password', () => {
    expect(parseBasicAuth(basic('admin', 'a:b:c'))).toEqual({ user: 'admin', password: 'a:b:c' });
    expect(parseBasicAuth('Bearer abc')).toBeNull();
    expect(parseBasicAuth(undefined)).toBeNull();
  });

  it('blocks a key after too many failures until the window ends', () => {
    const l = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.fail('1.2.3.4', 0);
    expect(l.blockedFor('1.2.3.4', 10)).toBe(1);
    expect(l.blockedFor('5.6.7.8', 10)).toBe(0);
    expect(l.blockedFor('1.2.3.4', 1001)).toBe(0);
  });
});

describe('admin sign-in', () => {
  it('requires the right Basic credentials', async () => {
    const { app } = await setup();
    const none = await get(app, '/admin', {});
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Basic realm=/);
    expect((await get(app, '/admin', { authorization: basic('admin', 'wrong password') })).statusCode).toBe(401);
    expect((await get(app, '/admin', { authorization: basic('someone', PASSWORD) })).statusCode).toBe(401);

    const ok = await get(app, '/admin');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('<h1>Admin</h1>');
    expect(ok.body).toContain('/static/admin.css');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(ok.body).toContain('noindex');
  });

  it('stays locked when no password hash is configured', async () => {
    const { app } = await setup({ ADMIN_PASSWORD_HASH: 'scrypt$unset$unset' });
    expect((await get(app, '/admin')).statusCode).toBe(401);
  });

  it('rate-limits repeated failures per IP, even for the right password', async () => {
    const { app } = await setup();
    for (let i = 0; i < 10; i++) expect((await get(app, '/admin', { authorization: basic('admin', `guess-${i}`) })).statusCode).toBe(401);
    const blocked = await get(app, '/admin');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Another address is unaffected.
    expect((await app.inject({ method: 'GET', url: '/admin', headers: AUTH(), remoteAddress: '198.51.100.9' })).statusCode).toBe(200);
  });

  it('shows dashboard counts', async () => {
    const { env, app } = await setup();
    const claim = makeClaim(env);
    env.ctx.repo.addMessage({ itemId: claim.itemId, direction: 'from_claimant', channel: 'portal', body: 'Hello' });
    env.ctx.jobs.enqueue('test.later', {}, { delayMs: 60_000 });
    const res = await get(app, '/admin');
    expect(res.body).toMatch(/<span class="stat-n">1<\/span>\s*<span class="stat-label">Claimant messages waiting to reach Monday/);
    expect(res.body).toMatch(/<span class="stat-n">1<\/span>\s*<span class="stat-label"><a href="\/admin\/jobs\?status=pending">Jobs waiting/);
  });
});

describe('admin CSRF', () => {
  const save = { action: 'save', emailSubject: 'New subject {{claimNumber}}', emailBody: 'Hi {{firstName}}', sms: '', portalText: 'Next steps' };

  it('rejects POSTs without the token or from another origin', async () => {
    const { env, app, csrf } = await setup();
    expect((await postForm(app, '/admin/templates/under_review', save)).statusCode).toBe(403);
    expect((await postForm(app, '/admin/templates/under_review', { ...save, _csrf: 'nope' })).statusCode).toBe(403);
    expect((await postForm(app, '/admin/templates/under_review', { ...save, _csrf: csrf }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await postForm(app, '/admin/templates/under_review', { ...save, _csrf: csrf }, { referer: 'https://evil.example/x' })).statusCode).toBe(403);
    expect((await postForm(app, '/admin/templates/under_review', { ...save, _csrf: csrf }, { origin: 'null' })).statusCode).toBe(403);
    expect(env.ctx.repo.getTemplateOverride('under_review')).toBeNull();

    const ok = await postForm(app, '/admin/templates/under_review', { ...save, _csrf: csrf }, { origin: 'https://claims.test' });
    expect(ok.statusCode).toBe(303);
  });

  it('rejects POSTs without credentials before reading the form', async () => {
    const { app, csrf } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/templates/under_review/reset',
      payload: new URLSearchParams({ _csrf: csrf, confirm: 'yes' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('serves admin pages with a same-origin referrer policy and a strict CSP', async () => {
    const { app } = await setup();
    const res = await get(app, '/admin/templates');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toContain("script-src 'none'");
  });
});

describe('admin templates', () => {
  it('lists every template with its edited/default state', async () => {
    const { env, app } = await setup();
    env.ctx.services.templates.save({ ...env.ctx.services.templates.getDefault('closed'), emailSubject: 'Closed {{claimNumber}}' }, 'test');
    const res = await get(app, '/admin/templates');
    expect(res.statusCode).toBe(200);
    for (const key of ['received', 'denied', 'confirmation', 'login_code', 'status_reply']) expect(res.body).toContain(`/admin/templates/${key}"`);
    expect(res.body.match(/badge-edited/g)).toHaveLength(1);
    expect(res.body).toContain('&quot;Under review&quot;'); // the board label that triggers it
  });

  it('saves and resets a template', async () => {
    const { env, app, csrf } = await setup();
    const { templates } = env.ctx.services;
    const fields = {
      _csrf: csrf,
      action: 'save',
      emailSubject: 'Claim {{claimNumber}} is with a specialist',
      emailBody: 'Hi {{firstName}},\n\nWe are on it.\n\n{{portalUrl}}',
      sms: 'Home Delivery Claims: {{claimNumber}} is under review. {{portalUrl}}',
      portalText: 'We are reviewing it.',
    };
    const saved = await postForm(app, '/admin/templates/under_review', fields);
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe('/admin/templates/under_review?done=saved');
    expect(templates.get('under_review')).toMatchObject({ emailSubject: fields.emailSubject, sms: fields.sms, portalText: fields.portalText });
    const page = await get(app, '/admin/templates/under_review?done=saved');
    expect(page.body).toContain('badge-edited');
    expect(page.body).toContain('Saved.');

    // Reset needs the confirmation box.
    expect((await postForm(app, '/admin/templates/under_review/reset', { _csrf: csrf })).statusCode).toBe(400);
    expect(env.ctx.repo.getTemplateOverride('under_review')).not.toBeNull();
    const reset = await postForm(app, '/admin/templates/under_review/reset', { _csrf: csrf, confirm: 'yes' });
    expect(reset.statusCode).toBe(303);
    expect(env.ctx.repo.getTemplateOverride('under_review')).toBeNull();
    expect(templates.get('under_review')).toEqual(templates.getDefault('under_review'));
  });

  it('previews with sample values, escaped, without saving', async () => {
    const { env, app, csrf } = await setup();
    const res = await postForm(app, '/admin/templates/new_message', {
      _csrf: csrf,
      action: 'preview',
      emailSubject: '<b>New</b> message on {{claimNumber}}',
      emailBody: 'Hi {{firstName}},\n\n{{message}}\n\n<script>alert(1)</script>',
      sms: 'Home Delivery Claims: new message {{portalUrl}}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('&lt;b&gt;New&lt;/b&gt; message on HDC-000123');
    expect(res.body).toContain('Hi Jane,');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).toMatch(/\d+ characters, 1 text segment \(GSM-7\)/);
    expect(env.ctx.repo.getTemplateOverride('new_message')).toBeNull();
  });

  it('refuses wording that would break messages or leak amounts', async () => {
    const { env, app, csrf } = await setup();
    const base = { _csrf: csrf, action: 'save', emailSubject: 'Subject', emailBody: 'Body', portalText: '' };
    const cases: Array<Record<string, string>> = [
      { ...base, sms: 'Settled for {{settlementAmount}}' },
      { ...base, sms: 'You claimed {{amountClaimed}}' },
      { ...base, emailBody: 'Hi {{frstName}}', sms: '' },
      { ...base, emailSubject: '', sms: '' },
    ];
    for (const c of cases) expect((await postForm(app, '/admin/templates/under_review', c)).statusCode).toBe(400);
    // The sign-in code email must keep its code.
    expect((await postForm(app, '/admin/templates/login_code', { ...base, emailBody: 'No code here' })).statusCode).toBe(400);
    expect(env.ctx.repo.getTemplateOverride('under_review')).toBeNull();
    expect(env.ctx.repo.getTemplateOverride('login_code')).toBeNull();
  });

  it('answers 404 for an unknown template', async () => {
    const { app } = await setup();
    expect((await get(app, '/admin/templates/nope')).statusCode).toBe(404);
  });
});

describe('admin jobs', () => {
  it('lists dead jobs and retries one', async () => {
    const { env, app, csrf } = await setup();
    env.ctx.jobs.register('test.broken', async () => {
      throw new PermanentJobError('Monday said no\nstack line');
    });
    env.ctx.jobs.enqueue('test.broken', { x: 1 });
    await env.ctx.jobs.drain();
    const [dead] = env.ctx.jobs.list('dead');
    expect(dead).toBeDefined();

    const list = await get(app, '/admin/jobs?status=dead');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('test.broken');
    expect(list.body).toContain('Monday said no');
    expect(list.body).not.toContain('stack line');
    expect(list.body).toContain(`/admin/jobs/${dead!.id}/retry`);

    const retry = await postForm(app, `/admin/jobs/${dead!.id}/retry`, { _csrf: csrf });
    expect(retry.statusCode).toBe(303);
    const row = env.ctx.db.prepare('SELECT status, attempts FROM jobs WHERE id = ?').get(dead!.id);
    expect(row).toEqual({ status: 'pending', attempts: 0 });
    expect((await get(app, '/admin/jobs?status=pending')).body).toContain('test.broken');
    expect((await postForm(app, '/admin/jobs/999999/retry', { _csrf: csrf })).statusCode).toBe(404);
  });
});

describe('admin claims', () => {
  it('looks a claim up by number without showing its link', async () => {
    const { env, app } = await setup();
    const claim = makeClaim(env);
    const token = env.ctx.services.tokens.portalToken(claim.itemId, claim.tokenVersion);
    for (const q of [claim.claimNumber, claim.claimNumber.toLowerCase(), '1', claim.itemId, 'jane@example.com']) {
      const res = await get(app, `/admin/claims?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`Claim ${claim.claimNumber}`);
      expect(res.body).toContain('jane@example.com');
      expect(res.body).not.toContain(token);
    }
    expect((await get(app, '/admin/claims?q=HDC-999999')).statusCode).toBe(404);
    expect((await get(app, '/admin/claims?q=%3Cscript%3E')).statusCode).toBe(400);
  });

  it('emails the claimant their claim link', async () => {
    const { env, app, csrf } = await setup();
    const claim = makeClaim(env);
    const url = `/admin/claims/${claim.itemId}/send-link`;
    expect((await postForm(app, url, { _csrf: csrf })).statusCode).toBe(400); // not confirmed
    expect(env.highlevel.emails).toHaveLength(0);

    const res = await postForm(app, url, { _csrf: csrf, confirm: 'yes' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('done=link-sent');
    expect(env.highlevel.emails).toHaveLength(1);
    expect(env.highlevel.emails[0]!.text).toContain(env.ctx.services.tokens.portalUrl(claim));
  });

  it('replaces the claim link: old link and trusted browsers stop working, Monday gets the new link', async () => {
    const { env, app, csrf } = await setup();
    const { tokens } = env.ctx.services;
    let claim = makeClaim(env);
    claim = env.ctx.repo.updateClaim(claim.itemId, { highlevelContactId: await env.highlevel.upsertContact({ name: 'Jane Doe', firstName: 'Jane', email: 'jane@example.com', phone: null, smsOptIn: false }) })!;
    const oldToken = tokens.portalToken(claim.itemId, claim.tokenVersion);
    env.ctx.db
      .prepare('INSERT INTO devices (device_hash, item_id, token_version, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .run('device-hash', claim.itemId, claim.tokenVersion, nowIso(), nowIso());
    expect(tokens.claimForToken(oldToken)?.itemId).toBe(claim.itemId);

    const url = `/admin/claims/${claim.itemId}/replace-link`;
    expect((await postForm(app, url, { _csrf: csrf })).statusCode).toBe(400);
    expect(tokens.claimForToken(oldToken)).not.toBeNull();

    const res = await postForm(app, url, { _csrf: csrf, confirm: 'yes' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/admin/claims?q=${claim.claimNumber}&done=link-replaced`);

    const updated = env.ctx.repo.getClaim(claim.itemId)!;
    expect(updated.tokenVersion).toBe(claim.tokenVersion + 1);
    expect(tokens.claimForToken(oldToken)).toBeNull();
    const newToken = tokens.portalToken(claim.itemId, updated.tokenVersion);
    expect(tokens.claimForToken(newToken)?.itemId).toBe(claim.itemId);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE item_id = ?').get(claim.itemId)).toEqual({ n: 0 });

    const newUrl = tokens.portalUrl(updated);
    expect(env.monday.mustItem(claim.itemId).columnValues[env.board.columns.portalLink!]!.text).toBe(newUrl);
    expect(env.highlevel.contacts.get(claim.highlevelContactId!)!.customFields.portal_url).toBe(newUrl);

    // The old link now 404s on the portal.
    expect((await app.inject({ method: 'GET', url: `/c/${oldToken}` })).statusCode).toBe(404);

    const page = await get(app, res.headers.location as string);
    expect(page.body).toContain('The claim link was replaced');
    expect(page.body).not.toContain(newToken);
  });

  it('reports a failed Monday write and can retry it', async () => {
    const { env, app, csrf } = await setup();
    const claim = makeClaim(env);
    env.monday.failNext = 1;
    const res = await postForm(app, `/admin/claims/${claim.itemId}/replace-link`, { _csrf: csrf, confirm: 'yes' });
    expect(res.headers.location).toContain('warn=monday');
    const page = await get(app, res.headers.location as string);
    expect(page.body).toContain('Writing the new link to the Monday item failed');

    const retry = await postForm(app, `/admin/claims/${claim.itemId}/write-link`, { _csrf: csrf });
    expect(retry.headers.location).toContain('done=link-written');
    const updated = env.ctx.repo.getClaim(claim.itemId)!;
    expect(env.monday.mustItem(claim.itemId).columnValues[env.board.columns.portalLink!]!.text).toBe(env.ctx.services.tokens.portalUrl(updated));
  });
});

describe('smsLength', () => {
  it('counts GSM-7 and Unicode segments', () => {
    expect(smsLength('a'.repeat(160))).toEqual({ chars: 160, segments: 1, encoding: 'GSM-7' });
    expect(smsLength('a'.repeat(161))).toEqual({ chars: 161, segments: 2, encoding: 'GSM-7' });
    expect(smsLength('€'.repeat(80))).toEqual({ chars: 160, segments: 1, encoding: 'GSM-7' });
    expect(smsLength('Claim — update')).toMatchObject({ segments: 1, encoding: 'Unicode' });
    expect(smsLength('x'.repeat(71) + '’')).toMatchObject({ chars: 72, segments: 2, encoding: 'Unicode' });
  });
});
