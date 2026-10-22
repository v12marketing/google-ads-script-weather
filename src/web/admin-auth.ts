import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';

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

// Counts sign-in attempts per client in a fixed window: failures, plus
// attempts still being checked, so guesses sent all at once can't get past the
// limit before the first ones fail. In memory: a restart clears it, which is
// acceptable for a single-instance service.
export class FailureLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();
  private inFlight = new Map<string, number>();

  constructor(
    readonly maxFailures = 10,
    readonly windowMs = 15 * 60_000,
  ) {}

  // Seconds until the key may try again, or 0 if it isn't blocked.
  blockedFor(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    const failures = e && e.resetAt > now ? e.count : 0;
    if (failures + (this.inFlight.get(key) ?? 0) < this.maxFailures) return 0;
    return failures ? Math.ceil((e!.resetAt - now) / 1000) : 1;
  }

  // Call synchronously before checking a password. False (and nothing counted)
  // when the key is blocked; otherwise end the attempt with fail(), succeed()
  // or cancel().
  begin(key: string, now = Date.now()): boolean {
    if (this.blockedFor(key, now)) return false;
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    return true;
  }

  // The attempt was turned away before its password was checked.
  cancel(key: string): void {
    const n = (this.inFlight.get(key) ?? 0) - 1;
    if (n > 0) this.inFlight.set(key, n);
    else this.inFlight.delete(key);
  }

  fail(key: string, now = Date.now()): void {
    this.cancel(key);
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count++;
    if (this.entries.size > 10_000) this.prune(now);
  }

  succeed(key: string): void {
    this.cancel(key);
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
  }
}

// The limiter key for a client address. An IPv6 client usually holds a whole
// /64, so it is counted per /64; IPv4 (and IPv4-mapped IPv6) per address.
export function clientKey(ip: string): string {
  const addr = ip.split('%')[0]!;
  if (!isIPv6(addr)) return ip;
  const groups = (s: string): number[] =>
    s
      ? s.split(':').flatMap((g) => {
          if (!g.includes('.')) return [parseInt(g, 16)];
          const [a, b, c, d] = g.split('.').map(Number) as [number, number, number, number];
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  const [head = '', tail] = addr.split('::');
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
  if (all.slice(0, 5).every((g) => g === 0) && all[5] === 0xffff) {
    return [all[6]! >> 8, all[6]! & 255, all[7]! >> 8, all[7]! & 255].join('.');
  }
  return `${all
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

// At most `max` slow operations (password hashing) at once. Callers that find
// it full are turned away rather than queued: scrypt runs on libuv's small
// thread pool, which file reads and DNS lookups for every request share.
export class ConcurrencyLimit {
  private active = 0;

  constructor(readonly max: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active--;
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
