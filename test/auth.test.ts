import { describe, expect, it, vi } from 'vitest';
import type { NewClaim } from '../src/db/repo.js';
import { maskEmail } from '../src/services/auth.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let nextItem = 5000;

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

const lastCode = (env: TestEnv): string => {
  const m = env.highlevel.emails.at(-1)?.text.match(/^(\d{6})$/m);
  if (!m) throw new Error('no login code email');
  return m[1]!;
};

const codeRows = (env: TestEnv) =>
  env.ctx.db.prepare('SELECT * FROM login_codes ORDER BY id').all() as Array<{ code_hash: string; device_hash: string; attempts: number }>;

const ageCodes = (env: TestEnv, ms: number) =>
  env.ctx.db.prepare('UPDATE login_codes SET created_at = ?').run(new Date(Date.now() - ms).toISOString());

function setup(o: Partial<NewClaim> = {}) {
  const env = makeTestEnv();
  const claim = makeClaim(env, o);
  const auth = env.ctx.services.auth;
  return { env, claim, auth, device: auth.newDeviceId() };
}

describe('device ids and CSRF tokens', () => {
  it('makes unguessable base64url device ids', () => {
    const { auth } = setup();
    const ids = new Set(Array.from({ length: 50 }, () => auth.newDeviceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('binds CSRF tokens to the device and the claim', () => {
    const { auth, device } = setup();
    const token = auth.csrfToken(device, '1');
    expect(auth.checkCsrf(device, '1', token)).toBe(true);
    expect(auth.checkCsrf(device, '2', token)).toBe(false);
    expect(auth.checkCsrf(auth.newDeviceId(), '1', token)).toBe(false);
    expect(auth.checkCsrf(device, '1', undefined)).toBe(false);
    expect(auth.checkCsrf(device, '1', '')).toBe(false);
    expect(auth.checkCsrf(device, '1', token.slice(0, -1))).toBe(false);
  });

  it('masks email addresses for display', () => {
    expect(maskEmail('jane@example.com')).toBe('j***@e***.com');
    expect(maskEmail(' Bob.Smith@mail.co.uk ')).toBe('B***@m***.uk');
    expect(maskEmail(null)).toBe('');
    expect(maskEmail('not-an-email')).toBe('');
  });
});

describe('auth.sendLoginCode', () => {
  it('emails a 6-digit code (never by SMS) and stores only its hash, bound to the device', async () => {
    const { env, claim, auth, device } = setup();
    const res = await auth.sendLoginCode(claim, device);
    expect(res).toEqual({ sent: true, maskedEmail: 'j***@e***.com' });
    expect(env.highlevel.emails).toHaveLength(1);
    // SMS is enabled and the claimant opted in, but codes only go by email.
    expect(env.highlevel.sms).toHaveLength(0);
    const code = lastCode(env);
    const rows = codeRows(env);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain(device);
  });

  it('needs an email address on the claim', async () => {
    const { env, claim, auth, device } = setup({ email: null });
    expect(await auth.sendLoginCode(claim, device)).toEqual({ sent: false, maskedEmail: '' });
    expect(env.highlevel.emails).toHaveLength(0);
    expect(codeRows(env)).toHaveLength(0);
  });

  it('sends at most 3 codes per claim per 15 minutes and 10 per day', async () => {
    const { env, claim, auth, device } = setup();
    for (let i = 0; i < 3; i++) expect((await auth.sendLoginCode(claim, device)).sent).toBe(true);
    // The limit is per claim, not per device.
    expect((await auth.sendLoginCode(claim, auth.newDeviceId())).sent).toBe(false);
    expect(env.highlevel.emails).toHaveLength(3);

    ageCodes(env, 16 * 60_000);
    expect((await auth.sendLoginCode(claim, device)).sent).toBe(true);

    const insert = env.ctx.db.prepare(
      `INSERT INTO login_codes (item_id, device_hash, code_hash, expires_at, created_at) VALUES (?, 'x', 'x', ?, ?)`,
    );
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    for (let i = 0; i < 6; i++) insert.run(claim.itemId, hourAgo, hourAgo);
    expect((await auth.sendLoginCode(claim, device)).sent).toBe(false);
  });

  it("drops a code whose email failed, so it neither works nor counts", async () => {
    const { env, claim, auth, device } = setup();
    env.highlevel.failNext = 1;
    await expect(auth.sendLoginCode(claim, device)).rejects.toThrow();
    expect(codeRows(env)).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect((await auth.sendLoginCode(claim, device)).sent).toBe(true);
  });
});

describe('auth.verifyLoginCode', () => {
  it('rejects a wrong code, then trusts the device on the right one', async () => {
    const { env, claim, auth, device } = setup();
    await auth.sendLoginCode(claim, device);
    const code = lastCode(env);
    const wrong = code === '000000' ? '111111' : '000000';
    expect(auth.isDeviceTrusted(claim, device)).toBe(false);
    expect(auth.verifyLoginCode(claim, device, wrong)).toBe('invalid');
    expect(codeRows(env)[0]!.attempts).toBe(1);
    // Malformed input isn't a guess and costs no attempt.
    expect(auth.verifyLoginCode(claim, device, '12')).toBe('invalid');
    expect(codeRows(env)[0]!.attempts).toBe(1);

    expect(auth.verifyLoginCode(claim, device, ` ${code.slice(0, 3)} ${code.slice(3)} `, 'TestBrowser/1.0')).toBe('ok');
    expect(auth.isDeviceTrusted(claim, device)).toBe(true);
    expect(auth.isDeviceTrusted(claim, auth.newDeviceId())).toBe(false);
    expect(auth.isDeviceTrusted(claim, undefined)).toBe(false);
    const row = env.ctx.db.prepare('SELECT * FROM devices').get() as { device_hash: string; user_agent: string; token_version: number };
    expect(row.device_hash).not.toBe(device);
    expect(row.user_agent).toBe('TestBrowser/1.0');
    expect(row.token_version).toBe(1);

    // Single use.
    expect(auth.verifyLoginCode(claim, device, code)).toBe('expired');
  });

  it('only accepts the code on the device that asked for it, and only the latest code', async () => {
    const { env, claim, auth, device } = setup();
    await auth.sendLoginCode(claim, device);
    const first = lastCode(env);
    expect(auth.verifyLoginCode(claim, auth.newDeviceId(), first)).toBe('expired');

    await auth.sendLoginCode(claim, device);
    const second = lastCode(env);
    if (first !== second) expect(auth.verifyLoginCode(claim, device, first)).toBe('invalid');
    expect(auth.verifyLoginCode(claim, device, second)).toBe('ok');
  });

  it('expires codes after 10 minutes', async () => {
    const { env, claim, auth, device } = setup();
    await auth.sendLoginCode(claim, device);
    const code = lastCode(env);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
      expect(auth.verifyLoginCode(claim, device, code)).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
    expect(auth.isDeviceTrusted(claim, device)).toBe(false);
  });

  it('locks the code after 5 wrong attempts', async () => {
    const { env, claim, auth, device } = setup();
    await auth.sendLoginCode(claim, device);
    const code = lastCode(env);
    const wrong = code === '999999' ? '888888' : '999999';
    for (let i = 0; i < 4; i++) expect(auth.verifyLoginCode(claim, device, wrong)).toBe('invalid');
    expect(auth.verifyLoginCode(claim, device, wrong)).toBe('locked');
    expect(auth.verifyLoginCode(claim, device, code)).toBe('locked');
    expect(auth.isDeviceTrusted(claim, device)).toBe(false);

    // A new code starts over.
    await auth.sendLoginCode(claim, device);
    expect(auth.verifyLoginCode(claim, device, lastCode(env))).toBe('ok');
  });

  it('stops trusting devices when the claim token is rotated', async () => {
    const { env, claim, auth, device } = setup();
    await auth.sendLoginCode(claim, device);
    expect(auth.verifyLoginCode(claim, device, lastCode(env))).toBe('ok');
    const { tokens } = env.ctx.services;
    const rotated = env.ctx.repo.updateClaim(claim.itemId, {
      tokenVersion: 2,
      tokenHash: tokens.tokenHash(tokens.portalToken(claim.itemId, 2)),
    })!;
    expect(auth.isDeviceTrusted(rotated, device)).toBe(false);

    await auth.sendLoginCode(rotated, device);
    expect(auth.verifyLoginCode(rotated, device, lastCode(env))).toBe('ok');
    expect(auth.isDeviceTrusted(rotated, device)).toBe(true);
  });
});

describe('auth.sendClaimLinks', () => {
  it('emails one list of every claim on the address, through the most recent claim', async () => {
    const env = makeTestEnv();
    const older = makeClaim(env, { email: 'Jane@Example.com', receivedAt: '2026-01-05T12:00:00.000Z' });
    const newer = makeClaim(env, { email: 'jane@example.com', receivedAt: '2026-09-01T12:00:00.000Z' });
    makeClaim(env, { email: 'someone@else.com' });

    await expect(env.ctx.services.auth.sendClaimLinks('  JANE@example.COM ')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(env.highlevel.emails).toHaveLength(1));
    const email = env.highlevel.emails[0]!;
    const { tokens } = env.ctx.services;
    expect(email.text).toContain(`${newer.claimNumber} — ${tokens.portalUrl(newer)}`);
    expect(email.text).toContain(`${older.claimNumber} — ${tokens.portalUrl(older)}`);
    expect(email.text.indexOf(newer.claimNumber)).toBeLessThan(email.text.indexOf(older.claimNumber));
    expect(email.text).not.toContain('HDC-000003');
    expect(email.contactId).toBe(env.ctx.repo.getClaim(newer.itemId)!.highlevelContactId);
    expect(env.highlevel.sms).toHaveLength(0);
  });

  it('resolves the same way for an unknown or invalid address and sends nothing', async () => {
    const env = makeTestEnv();
    makeClaim(env);
    await expect(env.ctx.services.auth.sendClaimLinks('nobody@example.com')).resolves.toBeUndefined();
    await expect(env.ctx.services.auth.sendClaimLinks('not an email')).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(env.highlevel.emails).toHaveLength(0);
  });

  it('silently limits each address to 3 requests an hour, known or not', async () => {
    const env = makeTestEnv();
    makeClaim(env);
    const { auth } = env.ctx.services;
    for (let i = 0; i < 5; i++) await expect(auth.sendClaimLinks('jane@example.com')).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(env.highlevel.emails).toHaveLength(3);

    for (let i = 0; i < 4; i++) await auth.sendClaimLinks('unknown@example.com');
    const rows = env.ctx.db.prepare('SELECT * FROM auth_rate_events').all() as Array<{ subject_hash: string }>;
    expect(rows).toHaveLength(6);
    expect(JSON.stringify(rows)).not.toContain('example.com');
  });

  it('logs a failed send without throwing', async () => {
    const env = makeTestEnv();
    makeClaim(env);
    const warn = vi.spyOn(env.ctx.log, 'warn');
    try {
      env.highlevel.failNext = 1;
      await expect(env.ctx.services.auth.sendClaimLinks('jane@example.com')).resolves.toBeUndefined();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\/c\//);
    } finally {
      warn.mockRestore();
    }
  });
});
