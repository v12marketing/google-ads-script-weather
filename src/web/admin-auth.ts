import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Admin password hashing (scrypt) and the pieces of HTTP Basic auth the admin
// routes need. Hash format: scrypt$<saltB64>$<hashB64>, N=16384 r=8 p=1, 64 bytes.

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;

function derive(password: string, salt: Buffer, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, keyLen, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('Password must not be empty');
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// False for a wrong password and for a malformed stored hash (admin stays locked).
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.trim().split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !B64_RE.test(parts[1]!) || !B64_RE.test(parts[2]!)) return false;
  const salt = Buffer.from(parts[1]!, 'base64');
  const expected = Buffer.from(parts[2]!, 'base64');
  if (salt.length < 8 || expected.length < 32 || expected.length > 128) return false;
  const actual = await derive(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

// Equal-length digests, so comparing strings of different lengths is constant-time too.
export function safeEqualStrings(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export function parseBasicAuth(header: string | undefined): { user: string; password: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]{1,1024})\s*$/i.exec(header ?? '');
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

// A fixed per-user token is enough here: Basic auth means no session to bind to,
// and the Origin/Referer check covers the rest.
export function adminCsrfToken(appSecret: string, adminUser: string): string {
  return createHmac('sha256', appSecret).update(`admin-csrf:${adminUser}`).digest('base64url');
}

// Counts failed sign-ins per client IP in a fixed window. In memory: a restart
// clears it, which is acceptable for a single-instance service.
export class FailureLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly maxFailures = 10,
    readonly windowMs = 15 * 60_000,
  ) {}

  // Seconds until the key may try again, or 0 if it isn't blocked.
  blockedFor(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) return 0;
    return e.count >= this.maxFailures ? Math.ceil((e.resetAt - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()): void {
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count++;
    if (this.entries.size > 10_000) this.prune(now);
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
  }
}

// Remembers recently verified Authorization headers (by HMAC, never the header
// itself) so every admin request doesn't pay for a scrypt run.
export class VerifiedCredentialCache {
  private entries = new Map<string, number>();

  constructor(
    private secret: string,
    readonly ttlMs = 10 * 60_000,
  ) {}

  private key(header: string): string {
    return createHmac('sha256', this.secret).update(`admin-auth:${header}`).digest('base64url');
  }

  has(header: string, now = Date.now()): boolean {
    const k = this.key(header);
    const exp = this.entries.get(k);
    if (exp === undefined) return false;
    if (exp <= now) {
      this.entries.delete(k);
      return false;
    }
    return true;
  }

  add(header: string, now = Date.now()): void {
    if (this.entries.size > 100) this.entries.clear();
    this.entries.set(this.key(header), now + this.ttlMs);
  }
}
