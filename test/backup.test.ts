import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { Repo, type NewClaim } from '../src/db/repo.js';
import { bumpSequence, checkDatabase, createBackup, parseClaimNumber } from '../scripts/backup.js';

const ROOT = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hdc-backup-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const claim = (itemId: string): NewClaim => ({
  itemId,
  claimantName: 'Jane Doe',
  firstName: 'Jane',
  email: 'jane@example.com',
  phone: null,
  smsOptIn: false,
  statusKey: 'received',
  statusLabel: 'New',
  amountClaimed: null,
  receivedAt: '2026-10-01T12:00:00.000Z',
});
const hashFor = (itemId: string, v: number) => `hash-${itemId}-${v}`;

// A data directory as the running app leaves it: the database (with recent
// writes still in its WAL file), cached files, the webhook ids, earlier backups.
function liveDataDir() {
  const dataDir = tempDir();
  const db = openDb(dataDir);
  const repo = new Repo(db);
  repo.createClaim(claim('101'), hashFor);
  repo.createClaim(claim('102'), hashFor);
  mkdirSync(join(dataDir, 'files', '101'), { recursive: true });
  writeFileSync(join(dataDir, 'files', '101', 'photo.jpg'), 'jpeg bytes');
  writeFileSync(join(dataDir, 'monday-webhooks.json'), '{"webhooks":[]}\n');
  mkdirSync(join(dataDir, 'backups'));
  writeFileSync(join(dataDir, 'backups', 'hdc-old.tar.gz'), 'old archive');
  return { dataDir, db, repo };
}

const listArchive = (archive: string): string[] =>
  execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((n) => n.replace(/^\.\//, ''))
    .sort();

describe('scripts/backup.ts', () => {
  it('archives a consistent database copy and the cached files, not the live database files or old backups', async () => {
    const { dataDir, db } = liveDataDir();
    try {
      const out = join(tempDir(), 'out');
      const archive = await createBackup(dataDir, out, new Date('2026-10-22T03:30:00Z'));
      expect(archive).toBe(join(out, 'hdc-20261022-033000.tar.gz'));
      expect(statSync(archive!).mode & 0o777).toBe(0o600);

      const names = listArchive(archive!);
      expect(names).toEqual(expect.arrayContaining(['hdc.sqlite', 'files/101/photo.jpg', 'monday-webhooks.json']));
      expect(names.some((n) => n.startsWith('hdc.sqlite-') || n.startsWith('backups') || n.startsWith('.backup-'))).toBe(false);

      // Restoring = unpacking into an empty data directory.
      const restored = tempDir();
      execFileSync('tar', ['-xzf', archive!, '-C', restored]);
      expect(readFileSync(join(restored, 'files', '101', 'photo.jpg'), 'utf8')).toBe('jpeg bytes');
      const copy = openDb(restored);
      const repo = new Repo(copy);
      expect(repo.getClaim('102')?.claimNumber).toBe('HDC-000002');
      copy.close();
      // The scratch copy is gone.
      expect(readdirSync(dataDir).filter((n) => n.startsWith('.backup-'))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('streams the archive to stdout with --out - (for docker compose exec from the host)', () => {
    const { dataDir, db } = liveDataDir();
    try {
      const res = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', '--out', '-'], {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: dataDir },
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(res.status, res.stderr.toString()).toBe(0);
      const archive = join(tempDir(), 'stdout.tar.gz');
      writeFileSync(archive, res.stdout);
      expect(listArchive(archive)).toEqual(expect.arrayContaining(['hdc.sqlite', 'files/101/photo.jpg']));
    } finally {
      db.close();
    }
  });

  it('--bump-sequence moves the claim-number sequence forward, never back', () => {
    const { dataDir, db } = liveDataDir();
    db.close();
    const dbPath = join(dataDir, 'hdc.sqlite');
    expect(bumpSequence(dbPath, parseClaimNumber('HDC-001234'))).toEqual({ before: 2, after: 1234 });
    expect(bumpSequence(dbPath, parseClaimNumber('500'))).toEqual({ before: 1234, after: 1234 });
    expect(checkDatabase(dbPath)).toMatchObject({ integrity: 'ok', claims: 2, highestClaimNumber: 'HDC-000002', sequence: 1234 });

    const reopened = openDb(dataDir);
    const next = new Repo(reopened).createClaim(claim('103'), hashFor);
    expect(next.claim.claimNumber).toBe('HDC-001235');
    reopened.close();

    // From the command line, as documented.
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', '--bump-sequence', '2000'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('the next new claim is HDC-002001');
    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare('SELECT last FROM claim_number_seq').get() as { last: number }).last).toBe(2000);
    check.close();
  });

  it('accepts claim numbers with or without the HDC- prefix and rejects anything else', () => {
    expect(parseClaimNumber('1234')).toBe(1234);
    expect(parseClaimNumber(' hdc-000017 ')).toBe(17);
    expect(() => parseClaimNumber('HDC-12a')).toThrow(/Not a claim number/);
    expect(() => parseClaimNumber('-5')).toThrow(/Not a claim number/);
  });

  it('fails clearly when DATA_DIR has no database', async () => {
    await expect(createBackup(tempDir(), tempDir())).rejects.toThrow(/No database/);
  });
});

describe('WORKER_ENABLED', () => {
  const env = {
    PUBLIC_BASE_URL: 'https://claims.test',
    APP_SECRET: 'x'.repeat(40),
    WEBHOOK_SECRET: 'w'.repeat(20),
    MONDAY_API_TOKEN: 'restore-test',
    MONDAY_INTEGRATION_USER_ID: '1',
    HIGHLEVEL_API_TOKEN: 'restore-test',
    HIGHLEVEL_LOCATION_ID: 'loc',
    HIGHLEVEL_EMAIL_FROM: 'claims@claims.test',
    HIGHLEVEL_SETTLEMENT_TEMPLATE_ID: 'tmpl',
    HIGHLEVEL_USER_ID: 'user',
    ADMIN_PASSWORD_HASH: 'scrypt$a$b',
  };

  it('defaults to on and can be switched off', () => {
    expect(loadConfig(env).WORKER_ENABLED).toBe(true);
    expect(loadConfig({ ...env, WORKER_ENABLED: 'false' }).WORKER_ENABLED).toBe(false);
    expect(() => loadConfig({ ...env, WORKER_ENABLED: 'no' })).toThrow(/WORKER_ENABLED/);
  });
});
