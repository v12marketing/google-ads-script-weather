// Keeps deploy/ in step with the app: Caddy's limits against the app's, the log
// redaction, the network and the stop timeout. (Behaviour of the Caddyfile was
// checked against a real Caddy; these guard the values.)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STOP_TIMEOUT_MS } from '../src/services/jobs.js';
import { MAX_UPLOAD_REQUEST_BYTES } from '../src/web/routes/portal.js';
import { WEBHOOK_BODY_LIMIT } from '../src/web/routes/webhooks.js';

const ROOT = resolve(import.meta.dirname, '..');
const caddyfile = readFileSync(resolve(ROOT, 'deploy/Caddyfile'), 'utf8');
const compose = readFileSync(resolve(ROOT, 'deploy/docker-compose.yml'), 'utf8');
// Caddyfile directives, with comments removed.
const directives = caddyfile
  .split('\n')
  .map((l) => l.replace(/^\s*#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');

const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 };
function maxSizeFor(matcher: string): number {
  const m = new RegExp(`request_body ${matcher} \\{\\s*max_size (\\d+)([A-Za-z]+)`).exec(directives);
  if (!m) throw new Error(`no request_body ${matcher} block`);
  return Number(m[1]) * UNITS[m[2]!.toUpperCase()]!;
}

describe('deploy/Caddyfile', () => {
  it('lets a full claim-page upload through to the app, which explains its own limits', () => {
    expect(directives).toContain('@upload path /c/*/files');
    // Room for the multipart encoding of up to 10 files and the CSRF field.
    expect(maxSizeFor('@upload')).toBeGreaterThanOrEqual(MAX_UPLOAD_REQUEST_BYTES + 1024 * 1024);
  });

  it('keeps every other request small, but not below what the app accepts', () => {
    expect(directives).toContain('@not_upload not path /c/*/files');
    expect(maxSizeFor('@not_upload')).toBeGreaterThanOrEqual(WEBHOOK_BODY_LIMIT);
    expect(maxSizeFor('@not_upload')).toBeLessThanOrEqual(10 * 1e6);
  });

  it('answers its own errors with a page (413 for oversized uploads) instead of an empty response', () => {
    expect(directives).toMatch(/handle_errors \{/);
    expect(directives).toMatch(/\{err\.status_code\} == 413/);
  });

  it('never logs request URIs, which carry claim links and the webhook secret', () => {
    expect(directives).toMatch(/log default \{[\s\S]*format filter \{[\s\S]*request>uri delete/);
    expect(directives).not.toMatch(/^log( \{)?$/m); // no access log in a site block
  });

  it('does not trust client-sent X-Forwarded-For', () => {
    expect(directives).not.toContain('trusted_proxies');
  });
});

describe('deploy/docker-compose.yml', () => {
  it('gives the network IPv6 so IPv6 clients keep their own address', () => {
    expect(compose).toMatch(/networks:\s*\n\s+default:[\s\S]*enable_ipv6: true[\s\S]*subnet: [0-9a-f:]+\/\d+/);
  });

  it('waits longer than the app does for the job in progress before killing it', () => {
    const m = /stop_grace_period: (\d+)s/.exec(compose);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeGreaterThanOrEqual(STOP_TIMEOUT_MS + 3000);
  });

  it('never publishes the app port (the app trusts X-Forwarded-For from whatever reaches it)', () => {
    const app = /\n {2}app:\n([\s\S]*?)\n {2}caddy:/.exec(compose)?.[1] ?? '';
    expect(app).toContain('expose:');
    expect(app).not.toMatch(/^\s+ports:/m);
  });
});
