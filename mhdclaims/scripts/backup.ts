// Backs up the data directory, checks a database, and moves the claim-number
// sequence forward after a restore. Reads only DATA_DIR from the environment.
//
//   npm run backup                           DATA_DIR/backups/hdc-<UTC stamp>.tar.gz
//   npm run backup -- --out <dir>            the archive goes into <dir> instead
//   npm run --silent backup -- --out -       the archive goes to stdout (without
//                                            --silent, npm prints its own lines there first)
//   npm run backup -- --check                integrity check, claim count, highest claim number
//   npm run backup -- --bump-sequence 1234   the next new claim gets at least HDC-001235
//
// In the production container (no tsx), as the app user, e.g. from the host:
//   docker compose exec -T app node dist/scripts/backup.js --out - > /opt/hdc-backups/hdc-<stamp>.tar.gz
//
// The archive holds a consistent copy of the database, made with SQLite's online
// backup (safe while the app runs), as hdc.sqlite, plus everything else in
// DATA_DIR: the cached claim files (files/) and the Monday webhook ids. To
// restore, unpack it into an empty DATA_DIR (docs/SETUP.md section 12).

import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatClaimNumber } from '../src/db/repo.js';

export const DB_FILE = 'hdc.sqlite';
const BACKUPS_DIR = 'backups';
const TMP_PREFIX = '.backup-';
// Never archived from DATA_DIR: the live database (its consistent copy is), and
// our own output and scratch space.
const SKIP = new Set([DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`, BACKUPS_DIR]);

const openExisting = (dbPath: string): Database.Database => {
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}. Is DATA_DIR right?`);
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
};

// UTC, sortable: 20261022-153000
export const backupStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function run(cmd: string, args: string[], toStdout: boolean): Promise<{ code: number; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: ['ignore', toStdout ? 'inherit' : 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', fail);
    // Killed by a signal (no exit code): the archive is cut short, so a failure,
    // never GNU tar's harmless exit 1.
    child.on('close', (code, signal) => done(code === null ? { code: 128, stderr: `${stderr}tar was stopped (${signal ?? 'signal'})` } : { code, stderr }));
  });
}

// Writes the archive into outDir (created if missing) and returns its path, or
// to stdout when outDir is '-' (returns null). Files are readable by the owner only.
export async function createBackup(dataDir: string, outDir: string, now = new Date()): Promise<string | null> {
  const dbPath = join(dataDir, DB_FILE);
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}. Is DATA_DIR right?`);
  const tmp = mkdtempSync(join(dataDir, TMP_PREFIX));
  try {
    const copy = join(tmp, DB_FILE);
    const db = openExisting(dbPath);
    try {
      await db.backup(copy);
    } finally {
      db.close();
    }
    const check = new Database(copy, { fileMustExist: true });
    try {
      const result = check.pragma('quick_check', { simple: true });
      if (result !== 'ok') throw new Error(`The database copy failed its integrity check: ${String(result)}`);
    } finally {
      check.close();
    }

    const toStdout = outDir === '-';
    let target = '-';
    let final: string | null = null;
    if (!toStdout) {
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      final = join(outDir, `hdc-${backupStamp(now)}.tar.gz`);
      target = `${final}.part`;
    }
    // './name' so that no file name is read as a tar option.
    const others = readdirSync(dataDir)
      .filter((n) => !SKIP.has(n) && !n.startsWith(TMP_PREFIX))
      .sort()
      .map((n) => `./${n}`);
    const args = ['-czf', target, '-C', tmp, DB_FILE, ...(others.length ? ['-C', dataDir, ...others] : [])];
    const { code, stderr } = await run('tar', args, toStdout);
    // GNU tar exits 1 when a file changed while it was read (a claimant upload
    // landing mid-backup); the archive is still usable and the database copy is
    // unaffected. Anything else is a failure.
    if (code > 1) {
      if (target !== '-') rmSync(target, { force: true });
      throw new Error(`tar failed (exit ${code}): ${stderr.trim()}`);
    }
    if (code === 1) process.stderr.write(`Warning: some cached files changed while being archived.\n${stderr}`);
    if (final) {
      chmodSync(target, 0o600);
      renameSync(target, final);
    }
    return final;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// "1234" or "HDC-001234" -> 1234.
export function parseClaimNumber(value: string): number {
  const m = /^(?:HDC-)?(\d{1,9})$/i.exec(value.trim());
  if (!m) throw new Error(`Not a claim number: "${value}". Use e.g. 1234 or HDC-001234.`);
  return Number(m[1]);
}

// Moves the claim-number sequence to at least `atLeast` (and past every claim in
// the database), so the next new claim is numbered above it. Never moves it back.
export function bumpSequence(dbPath: string, atLeast: number): { before: number; after: number } {
  const db = openExisting(dbPath);
  try {
    return db.transaction(() => {
      const before = (db.prepare('SELECT last FROM claim_number_seq WHERE id = 1').get() as { last: number }).last;
      const highest = (db.prepare('SELECT MAX(seq) AS m FROM claims').get() as { m: number | null }).m ?? 0;
      const after = Math.max(before, highest, atLeast);
      db.prepare('UPDATE claim_number_seq SET last = ? WHERE id = 1').run(after);
      return { before, after };
    })();
  } finally {
    db.close();
  }
}

export interface DbSummary {
  integrity: string;
  claims: number;
  highestClaimNumber: string | null;
  sequence: number;
  jobs: Record<string, number>;
}

export function checkDatabase(dbPath: string): DbSummary {
  const db = openExisting(dbPath);
  try {
    const integrity = String(db.pragma('integrity_check', { simple: true }));
    const claims = (db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS m FROM claims').get() as { n: number; m: number | null });
    const sequence = (db.prepare('SELECT last FROM claim_number_seq WHERE id = 1').get() as { last: number }).last;
    const jobs = Object.fromEntries(
      (db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
    );
    return { integrity, claims: claims.n, highestClaimNumber: claims.m === null ? null : formatClaimNumber(claims.m), sequence, jobs };
  } finally {
    db.close();
  }
}

const USAGE = `Usage: backup [--out <dir> | --out -] | --check | --bump-sequence <claim number>
Reads DATA_DIR (default ./data). See the top of scripts/backup.ts and docs/SETUP.md section 12.`;

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      check: { type: 'boolean' },
      'bump-sequence': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.error(USAGE);
    return;
  }
  // Archives and the database copy hold personal data: owner-only.
  process.umask(0o077);
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const dbPath = join(dataDir, DB_FILE);

  if (values['bump-sequence'] !== undefined) {
    const { before, after } = bumpSequence(dbPath, parseClaimNumber(values['bump-sequence']));
    console.error(
      after === before
        ? `Claim-number sequence left at ${formatClaimNumber(after)}; the next new claim is ${formatClaimNumber(after + 1)}.`
        : `Claim-number sequence moved from ${formatClaimNumber(before)} to ${formatClaimNumber(after)}; the next new claim is ${formatClaimNumber(after + 1)}.`,
    );
    return;
  }
  if (values.check) {
    const s = checkDatabase(dbPath);
    const jobs = Object.entries(s.jobs).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
    console.log(`Integrity: ${s.integrity}`);
    console.log(`Claims: ${s.claims}. Highest claim number: ${s.highestClaimNumber ?? 'none'}. Next new claim: ${formatClaimNumber(s.sequence + 1)}.`);
    console.log(`Jobs: ${jobs}.`);
    if (s.integrity !== 'ok') process.exitCode = 1;
    return;
  }
  const out = values.out ?? join(dataDir, BACKUPS_DIR);
  // `npm run backup` without --silent has already printed npm's own lines to
  // stdout, where they would end up in front of the archive and spoil it.
  if (out === '-' && process.env.npm_lifecycle_event === 'backup' && process.env.npm_config_loglevel !== 'silent') {
    throw new Error('npm writes its own lines to stdout ahead of the archive. Use: npm run --silent backup -- --out -');
  }
  const written = await createBackup(dataDir, out === '-' ? '-' : resolve(out));
  if (written) console.error(`Backup written: ${written}`);
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`Backup failed. ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
