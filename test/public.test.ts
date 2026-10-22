import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/web/app.js';
import { escapeHtml } from '../src/web/html.js';
import { CLAIM_LINKS_SENT } from '../src/web/pages/find-claim.js';
import { SMS_PRIVACY_STATEMENT } from '../src/web/pages/privacy.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

const PAGES: Array<{ path: string; title: string; contains: string[] }> = [
  { path: '/', title: 'File a delivery damage claim online | Home Delivery Claims', contains: ['Delivery damaged? File a claim online.', 'href="/start-a-claim"', 'href="/find-my-claim"', "What you'll need", 'Updates come to you'] },
  { path: '/start-a-claim', title: 'Start a claim | Home Delivery Claims', contains: ['Have these ready', '<iframe', 'Form not loading?', 'claim number', 'Reply STOP to cancel'] },
  { path: '/how-it-works', title: 'How it works | Home Delivery Claims', contains: ['More information needed', 'Estimate in progress', 'Settlement offered', 'Payment sent', '6-digit code', 'Text STATUS'] },
  { path: '/faq', title: 'Frequently asked questions | Home Delivery Claims', contains: ['<details', 'Is my bank information safe?', 'How do I stop texts?'] },
  { path: '/privacy', title: 'Privacy Policy | Home Delivery Claims', contains: ['DRAFT for counsel review', SMS_PRIVACY_STATEMENT, '[Claims entity legal name]'] },
  { path: '/terms', title: 'Terms of Use | Home Delivery Claims', contains: ['DRAFT for counsel review', 'id="sms-terms"', 'Home Delivery Claims claim updates', 'Message frequency varies', 'Message and data rates may apply', 'Carriers are not liable', 'href="/privacy'] },
  { path: '/find-my-claim', title: 'Find my claim | Home Delivery Claims', contains: ['<form', 'name="email"', 'autocomplete="email"'] },
];

const visibleText = (body: string): string =>
  body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

let env: TestEnv;
let app: FastifyInstance;

async function setup(opts: Parameters<typeof makeTestEnv>[0] = {}) {
  env = makeTestEnv(opts);
  app = await buildApp(env.ctx);
  return app;
}

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

const postEmail = (email: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/find-my-claim', payload: new URLSearchParams({ email, ...extra }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

describe('public pages', () => {
  it('serves every page with a title, key content and nav state', async () => {
    await setup();
    for (const p of PAGES) {
      const res = await app.inject({ url: p.path });
      expect(res.statusCode, p.path).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain(`<title>${escapeHtml(p.title)}</title>`);
      expect(res.body).toContain('<meta name="description"');
      for (const c of p.contains) expect(res.body, `${p.path}: ${c}`).toContain(c);
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
    const faq = await app.inject({ url: '/faq' });
    expect(faq.body).toContain('<a href="/faq" aria-current="page">');
    const count = (faq.body.match(/<details/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(10);
    expect(count).toBeLessThanOrEqual(14);
  });

  it('never mentions the operator, agency or the work-management platform', async () => {
    await setup();
    const embed = escapeHtml(env.board.claimForm.embedUrl);
    const paths = [...PAGES.map((p) => p.path), '/find-my-claim?sent=1', '/no-such-page'];
    for (const path of paths) {
      const res = await app.inject({ url: path });
      const text = visibleText(res.body);
      expect(text, path).not.toMatch(/\b(aria|v12|monday)\b/i);
      // Markup too, apart from the claim form's own URL.
      expect(res.body.replaceAll(embed, ''), path).not.toMatch(/monday|v12|aria logistics/i);
    }
  });

  it('embeds the claim form from the board config, with a CSP that allows it', async () => {
    const url = 'https://forms.monday.com/forms/abc123XYZ?r=use1&src=site';
    await setup({ board: { claimForm: { embedUrl: url } } });
    const res = await app.inject({ url: '/start-a-claim' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<iframe class="claim-form-frame" src="${escapeHtml(url)}" title="Claim form" width="100%" loading="lazy"></iframe>`);
    expect(res.body).toContain(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open it in a new window</a>`);
    expect(res.body).not.toContain(' allow=');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain('frame-src https://forms.monday.com https://*.monday.com');
    expect(csp).toContain("script-src 'self'");
    // Other pages frame nothing.
    const home = await app.inject({ url: '/' });
    expect(home.headers['content-security-policy']).toContain("frame-src 'none'");
  });

  it('refuses to frame a claim form URL that is not https', async () => {
    await setup({ board: { claimForm: { embedUrl: 'http://forms.example.com/f' } } });
    const res = await app.inject({ url: '/start-a-claim' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<iframe');
    expect(res.body).toContain("claim form isn't available");
    expect(res.headers['content-security-policy']).toContain("frame-src 'none'");
  });

  it('serves robots.txt and a sitemap of the public pages', async () => {
    await setup();
    const robots = await app.inject({ url: '/robots.txt' });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers['content-type']).toContain('text/plain');
    for (const line of ['User-agent: *', 'Disallow: /c/', 'Disallow: /admin', 'Disallow: /webhooks', 'Sitemap: https://claims.test/sitemap.xml']) {
      expect(robots.body).toContain(line);
    }
    const sitemap = await app.inject({ url: '/sitemap.xml' });
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.headers['content-type']).toContain('application/xml');
    for (const p of ['/', '/start-a-claim', '/how-it-works', '/faq', '/find-my-claim', '/privacy', '/terms']) {
      expect(sitemap.body).toContain(`<loc>https://claims.test${p}</loc>`);
    }
    expect(sitemap.body).not.toContain('/c/');
    expect(sitemap.body).not.toContain('/admin');
  });
});

describe('find my claim', () => {
  it('emails links and gives the same answer whether or not the address has claims', async () => {
    await setup();
    await addClaimItem(env, { email: 'jane@example.com' });
    const send = vi.fn(async (_email: string) => {});
    env.ctx.services.auth.sendClaimLinks = send;

    const known = await postEmail('  jane@example.com ');
    const unknown = await postEmail('nobody@example.org');
    expect(send.mock.calls).toEqual([['jane@example.com'], ['nobody@example.org']]);
    for (const res of [known, unknown]) {
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/find-my-claim?sent=1');
    }
    expect(known.body).toBe(unknown.body);
    expect(JSON.stringify(known.headers)).not.toContain('jane');

    const sent = await app.inject({ url: '/find-my-claim?sent=1' });
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain(escapeHtml(CLAIM_LINKS_SENT));
    expect(sent.body).not.toContain('jane@example.com');
  });

  it('gives the same answer when sending fails', async () => {
    await setup();
    env.ctx.services.auth.sendClaimLinks = vi.fn(async () => {
      throw new Error('email provider down');
    });
    const res = await postEmail('jane@example.com');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/find-my-claim?sent=1');
  });

  it('asks again for an invalid address, escaping what was typed', async () => {
    await setup();
    const send = vi.fn(async () => {});
    env.ctx.services.auth.sendClaimLinks = send;
    const res = await postEmail('"><script>alert(1)</script>');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Enter a valid email address');
    expect(res.body).toContain('aria-invalid="true"');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
    expect(send).not.toHaveBeenCalled();
  });

  it('answers bots that fill the hidden field without sending anything', async () => {
    await setup();
    const send = vi.fn(async () => {});
    env.ctx.services.auth.sendClaimLinks = send;
    const res = await postEmail('jane@example.com', { website: 'http://spam.example' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/find-my-claim?sent=1');
    expect(send).not.toHaveBeenCalled();
  });

  it('works end to end with the real auth service', async () => {
    await setup();
    const res = await postEmail('nobody@example.org');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/find-my-claim?sent=1');
  });

  it('rate-limits to 5 requests per 15 minutes per IP with a friendly page', async () => {
    await setup();
    env.ctx.services.auth.sendClaimLinks = vi.fn(async () => {});
    for (let i = 0; i < 5; i++) expect((await postEmail(`user${i}@example.com`)).statusCode).toBe(303);
    const res = await postEmail('user6@example.com');
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Too many tries');
    expect(res.headers['retry-after']).toBeDefined();
    expect(env.ctx.services.auth.sendClaimLinks).toHaveBeenCalledTimes(5);
  });

  it('counts an IPv6 client per /64, so changing address within it gets no fresh allowance', async () => {
    await setup();
    env.ctx.services.auth.sendClaimLinks = vi.fn(async () => {});
    const from = (ip: string, i: number) =>
      app.inject({
        method: 'POST',
        url: '/find-my-claim',
        payload: new URLSearchParams({ email: `user${i}@example.com` }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      });
    for (let i = 0; i < 5; i++) expect((await from(`2001:db8:1:2::${i + 1}`, i)).statusCode).toBe(303);
    expect((await from('2001:db8:1:2:ffff::9', 6)).statusCode).toBe(429);
    // Another /64 has its own allowance.
    expect((await from('2001:db8:1:3::1', 7)).statusCode).toBe(303);
  });
});

describe('errors', () => {
  it('shows a friendly 404 page, and JSON under /webhooks', async () => {
    await setup();
    const res = await app.inject({ url: '/no-such-page' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Page not found | Home Delivery Claims</title>');
    expect(res.body).toContain('href="/find-my-claim"');
    expect(res.body).toContain('noindex');

    const hook = await app.inject({ method: 'POST', url: '/webhooks/nope/nope', payload: {} });
    expect(hook.statusCode).toBe(404);
    expect(hook.json()).toEqual({ statusCode: 404, error: 'Not Found' });
  });

  it('shows a 500 page without leaking details, and JSON for webhooks', async () => {
    await setup();
    const logError = vi.spyOn(env.ctx.log, 'error');
    app.get('/__test/boom', async () => {
      throw new Error('secret detail https://files.example/abc?sig=xyz');
    });
    app.post('/webhooks/__test/boom', async () => {
      throw new Error('secret detail');
    });
    const res = await app.inject({ url: '/__test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Something went wrong on our side');
    expect(res.body).not.toContain('secret detail');
    expect(logError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logError.mock.calls)).not.toContain('files.example');

    const hook = await app.inject({ method: 'POST', url: '/webhooks/__test/boom', payload: {} });
    expect(hook.statusCode).toBe(500);
    expect(hook.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' });
  });

  it('keeps the status of client errors', async () => {
    await setup();
    app.get('/__test/bad', async () => {
      throw Object.assign(new Error('bad input detail'), { statusCode: 400 });
    });
    const res = await app.inject({ url: '/__test/bad' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('couldn&#39;t complete that request');
    expect(res.body).not.toContain('bad input detail');
  });
});
