import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { nowIso } from '../db/index.js';
import type { Claim } from '../domain/types.js';
import { html } from '../web/html.js';
import { businessDate, onceFor } from './claim-fields.js';
import type { AuthService, CoreContext, LoginCodeCheck, LoginCodeResult, Services } from './contracts.js';
import { ContactConflictError } from './notifier.js';

// Portal device trust. A browser proves it can read the claim's email with a
// one-time code; from then on its device cookie is trusted for that claim until
// the claim's tokenVersion changes or the claim's email does (intake.refreshClaim
// then forgets its devices). Device ids and codes are stored only as
// hashes, and neither is ever logged.

// 32 random bytes, base64url: what the signed hdc_device cookie carries.
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
// A code only works in the browser that asked for it, so the short-window limit
// is per claim and browser: someone else holding the link can't use up the
// claimant's codes. Browser ids cost nothing to make, so a generous daily cap
// per claim keeps the claimant's inbox from being flooded.
export const DEVICE_CODE_LIMIT = { windowMs: 15 * 60_000, max: 3 };
export const CLAIM_CODE_LIMIT = { windowMs: 24 * 60 * 60_000, max: 20 };
const CLAIM_LINKS_WINDOW_MS = 60 * 60_000;
const CLAIM_LINKS_MAX = 3;
const MAX_LISTED_CLAIMS = 20;
const KEEP_CODES_MS = 2 * 24 * 60 * 60_000;
// A page view also loads every thumbnail; don't write last_seen_at for each.
const TOUCH_INTERVAL_MS = 5 * 60_000;

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// "jane@example.com" -> "j***@e***.com"
export function maskEmail(email: string | null | undefined): string {
  const e = email?.trim() ?? '';
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return '';
  const local = Array.from(e.slice(0, at));
  const domain = e.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const name = Array.from(dot > 0 ? domain.slice(0, dot) : domain);
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${name[0] ?? ''}***${tld}`;
}

// Error text for logs: first line only, with links and anything code-shaped masked
// in case a provider error echoes the message it was sent.
const safeErr = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err))
    .split('\n')[0]!
    .slice(0, 200)
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\d{6}/g, '******');

export function createAuthService(ctx: CoreContext, services: Services): AuthService {
  const { db, repo, log } = ctx;

  const hmac = (s: string, enc: 'hex' | 'base64url' = 'hex'): string =>
    createHmac('sha256', ctx.config.APP_SECRET).update(s).digest(enc);
  const deviceHash = (deviceId: string): string => createHash('sha256').update(deviceId).digest('hex');
  const codeHash = (itemId: string, devHash: string, code: string): string => hmac(`login-code:${itemId}:${devHash}:${code}`);
  const validDevice = (deviceId: string | undefined): deviceId is string => typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId);

  function isDeviceTrusted(claim: Claim, deviceId: string | undefined): boolean {
    if (!validDevice(deviceId)) return false;
    const dh = deviceHash(deviceId);
    const row = db
      .prepare('SELECT token_version, last_seen_at FROM devices WHERE device_hash = ? AND item_id = ?')
      .get(dh, claim.itemId) as { token_version: number; last_seen_at: string } | undefined;
    if (!row || row.token_version !== claim.tokenVersion) return false;
    if (row.last_seen_at < isoAgo(TOUCH_INTERVAL_MS)) {
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_hash = ? AND item_id = ?').run(nowIso(), dh, claim.itemId);
    }
    return true;
  }

  // The daily cap only runs out if codes keep being asked for, most likely by
  // someone else who has the claim's link. Tell the team (once a day) so they can
  // replace the link and send the claimant the new one.
  const tellTeamCodeLimit = (claim: Claim): Promise<unknown> =>
    onceFor(ctx, `login-code-limit:${claim.itemId}:${businessDate(nowIso())}`, (once) =>
      ctx.monday.createUpdate(
        claim.itemId,
        html`<p>The claim page has emailed its daily maximum of ${CLAIM_CODE_LIMIT.max} login codes for this claim, so the claimant can't get a code on a new browser until tomorrow.</p>
<p>If the claimant didn't ask for them all, someone else may have the claim link: replace the link in /admin and email the claimant the new one.</p>`.value,
        once,
      ),
    ).catch((err) => log.warn({ itemId: claim.itemId, err: safeErr(err) }, 'auth: posting the login code limit note failed'));

  async function sendLoginCode(claim: Claim, deviceId: string): Promise<LoginCodeResult> {
    const maskedEmail = maskEmail(claim.email);
    if (!maskedEmail || !validDevice(deviceId)) return { sent: false, maskedEmail };
    const dh = deviceHash(deviceId);

    const issued = db.transaction((): { id: number; code: string } | { limited: 'device' | 'claim' } => {
      const { n: forDevice } = db
        .prepare('SELECT COUNT(*) AS n FROM login_codes WHERE item_id = ? AND device_hash = ? AND created_at > ?')
        .get(claim.itemId, dh, isoAgo(DEVICE_CODE_LIMIT.windowMs)) as { n: number };
      if (forDevice >= DEVICE_CODE_LIMIT.max) return { limited: 'device' };
      const { n: forClaim } = db
        .prepare('SELECT COUNT(*) AS n FROM login_codes WHERE item_id = ? AND created_at > ?')
        .get(claim.itemId, isoAgo(CLAIM_CODE_LIMIT.windowMs)) as { n: number };
      if (forClaim >= CLAIM_CODE_LIMIT.max) return { limited: 'claim' };
      db.prepare('DELETE FROM login_codes WHERE item_id = ? AND created_at < ?').run(claim.itemId, isoAgo(KEEP_CODES_MS));
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const now = Date.now();
      const res = db
        .prepare('INSERT INTO login_codes (item_id, device_hash, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(claim.itemId, dh, codeHash(claim.itemId, dh, code), new Date(now + LOGIN_CODE_TTL_MS).toISOString(), new Date(now).toISOString());
      return { id: Number(res.lastInsertRowid), code };
    })();

    if ('limited' in issued) {
      log.info({ itemId: claim.itemId, limit: issued.limited }, 'auth: login code rate-limited');
      if (issued.limited === 'claim') void tellTeamCodeLimit(claim);
      return { sent: false, maskedEmail, limited: issued.limited };
    }

    try {
      // login_code is an email-only template: the notifier never texts it, and
      // only emails a HighLevel contact whose email is the claim's.
      const res = await services.notifier.notify(claim, 'login_code', { code: issued.code });
      if (!res.emailSent) throw new Error('login code email was not sent');
    } catch (err) {
      // Never delivered: drop it so it can't be used and doesn't count against the limit.
      db.prepare('DELETE FROM login_codes WHERE id = ?').run(issued.id);
      if (err instanceof ContactConflictError) {
        log.warn({ itemId: claim.itemId }, "auth: login code not sent: the claim's HighLevel contact doesn't have its email");
      } else {
        log.warn({ itemId: claim.itemId, err: safeErr(err) }, 'auth: login code email failed');
      }
      throw err;
    }
    log.info({ itemId: claim.itemId }, 'auth: login code sent');
    return { sent: true, maskedEmail };
  }

  function verifyLoginCode(claim: Claim, deviceId: string, code: string, userAgent?: string): LoginCodeCheck {
    if (!validDevice(deviceId)) return 'invalid';
    const dh = deviceHash(deviceId);
    const given = typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';

    // This browser has no usable code, but another one has a live code for the
    // claim: most likely the code was asked for there (or this is a link opened
    // from the email on another device), so say so instead of "expired".
    const noCodeHere = (): 'expired' | 'other_device' => {
      const other = db
        .prepare('SELECT 1 FROM login_codes WHERE item_id = ? AND device_hash != ? AND used_at IS NULL AND expires_at > ? LIMIT 1')
        .get(claim.itemId, dh, nowIso());
      return other ? 'other_device' : 'expired';
    };

    return db.transaction((): LoginCodeCheck => {
      const row = db
        .prepare(
          `SELECT id, code_hash, attempts, expires_at FROM login_codes
           WHERE item_id = ? AND device_hash = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1`,
        )
        .get(claim.itemId, dh) as { id: number; code_hash: string; attempts: number; expires_at: string } | undefined;
      if (!row) return noCodeHere();
      if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return 'locked';
      if (row.expires_at <= nowIso()) return noCodeHere();
      // A typo that can't be a code isn't a guess; don't spend an attempt on it.
      if (!/^\d{6}$/.test(given)) return 'invalid';

      const attempts = row.attempts + 1;
      if (!safeEqual(codeHash(claim.itemId, dh, given), row.code_hash)) {
        db.prepare('UPDATE login_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
        log.info({ itemId: claim.itemId, attempts }, 'auth: wrong login code');
        return attempts >= LOGIN_CODE_MAX_ATTEMPTS ? 'locked' : 'invalid';
      }

      const now = nowIso();
      db.prepare('UPDATE login_codes SET attempts = ?, used_at = ? WHERE id = ?').run(attempts, now, row.id);
      db.prepare(
        `INSERT INTO devices (device_hash, item_id, token_version, user_agent, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_hash, item_id) DO UPDATE SET
           token_version = excluded.token_version, user_agent = excluded.user_agent, last_seen_at = excluded.last_seen_at`,
      ).run(dh, claim.itemId, claim.tokenVersion, userAgent?.slice(0, 300) ?? null, now, now);
      log.info({ itemId: claim.itemId }, 'auth: device verified');
      return 'ok';
    })();
  }

  const newDeviceId = (): string => randomBytes(32).toString('base64url');

  const csrfToken = (deviceId: string, itemId: string): string => hmac(`csrf:${deviceId}:${itemId}`, 'base64url');

  const checkCsrf = (deviceId: string, itemId: string, token: string | undefined): boolean =>
    typeof token === 'string' && safeEqual(token, csrfToken(deviceId, itemId));

  async function deliverClaimLinks(claims: Claim[]): Promise<void> {
    const claimList = claims
      .slice(0, MAX_LISTED_CLAIMS)
      .map((c) => `${c.claimNumber} — ${services.tokens.portalUrl(c)}`)
      .join('\n');
    // One email, sent through the most recent claim (its contact and footer).
    await services.notifier.notify(claims[0]!, 'claim_links', { claimList });
    log.info({ itemId: claims[0]!.itemId, claims: claims.length }, 'auth: claim links sent');
  }

  async function sendClaimLinks(email: string): Promise<void> {
    const addr = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (addr && addr.length <= 254 && EMAIL_RE.test(addr)) {
      const subject = hmac(`claim-links:${addr}`);
      // Counted whether or not the address is known, so the limit reveals nothing.
      const allowed = db.transaction(() => {
        const { n } = db
          .prepare(`SELECT COUNT(*) AS n FROM auth_rate_events WHERE kind = 'claim_links' AND subject_hash = ? AND created_at > ?`)
          .get(subject, isoAgo(CLAIM_LINKS_WINDOW_MS)) as { n: number };
        if (n >= CLAIM_LINKS_MAX) return false;
        db.prepare(`DELETE FROM auth_rate_events WHERE kind = 'claim_links' AND created_at < ?`).run(isoAgo(24 * 60 * 60_000));
        db.prepare(`INSERT INTO auth_rate_events (kind, subject_hash, created_at) VALUES ('claim_links', ?, ?)`).run(subject, nowIso());
        return true;
      })();
      const claims = allowed ? repo.findClaimsByEmail(addr).filter((c) => c.email) : [];
      if (!allowed) log.info({}, 'auth: claim links request rate-limited');
      // Not awaited: how long the request takes must not reveal whether the
      // address has claims. Failures are logged; the claimant can ask again.
      if (claims.length) void deliverClaimLinks(claims).catch((err) => log.warn({ err: safeErr(err) }, 'auth: claim links email failed'));
    }
    // Every path yields once the same way (in-process fakes settle here too).
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { isDeviceTrusted, sendLoginCode, verifyLoginCode, newDeviceId, csrfToken, checkCsrf, sendClaimLinks };
}
