// Starts the real entry point (src/server.ts) on a scratch data directory with
// dummy credentials. Only jobs of types nobody handles are queued, so nothing
// reaches Monday or HighLevel.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import type { JobRow } from '../src/services/jobs.js';

const ROOT = resolve(import.meta.dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(dataDir: string) {
  const db = openDb(dataDir);
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const add = (type: string, status: string, updatedAt: string) =>
    Number(
      db
        .prepare('INSERT INTO jobs (type, payload, status, run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(type, '{}', status, ago(1000), updatedAt, updatedAt).lastInsertRowid,
    );
  const ids = {
    due: add('test.unhandled', 'pending', ago(1000)),
    // Left 'running' in the backup: a worker would pick it up again.
    running: add('test.unhandled', 'running', ago(1000)),
    oldDone: add('test.unhandled', 'done', ago(30 * DAY)),
  };
  db.close();
  return ids;
}

function startServer(dataDir: string, extraEnv: Record<string, string>) {
  const env = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '0',
    PUBLIC_BASE_URL: 'https://claims.test',
    DATA_DIR: dataDir,
    BOARD_CONFIG_PATH: join(ROOT, 'config', 'board.example.json'),
    APP_SECRET: 'restore-test-secret-restore-test-secret-0123',
    WEBHOOK_SECRET: 'restore-test-webhook',
    MONDAY_API_TOKEN: 'restore-test',
    MONDAY_INTEGRATION_USER_ID: '1',
    HIGHLEVEL_API_TOKEN: 'restore-test',
    HIGHLEVEL_LOCATION_ID: 'restore-test',
    HIGHLEVEL_EMAIL_FROM: 'claims@claims.test',
    HIGHLEVEL_SETTLEMENT_TEMPLATE_ID: 'restore-test',
    HIGHLEVEL_USER_ID: 'restore-test',
    ADMIN_PASSWORD_HASH: 'scrypt$unset$unset',
    LOG_LEVEL: 'info',
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr.on('data', (c: Buffer) => (output += c.toString()));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const listening = new Promise<void>((done, fail) => {
    const timer = setInterval(() => {
      if (output.includes('Server listening')) {
        clearInterval(timer);
        done();
      }
    }, 50);
    void exited.then(() => {
      clearInterval(timer);
      fail(new Error(`server exited early:\n${output}`));
    });
  });
  return { child, exited, listening, output: () => output };
}

const readJobs = (dataDir: string) => {
  const db = openDb(dataDir);
  const rows = db.prepare('SELECT * FROM jobs').all() as JobRow[];
  db.close();
  return new Map(rows.map((r) => [r.id, r]));
};

describe('server worker switch and shutdown', () => {
  it('with WORKER_ENABLED=false runs no jobs and no retention, and stops cleanly on SIGTERM', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hdc-server-test-'));
    dirs.push(dataDir);
    const ids = seed(dataDir);
    const srv = startServer(dataDir, { WORKER_ENABLED: 'false' });
    await srv.listening;
    await new Promise((r) => setTimeout(r, 1500)); // > the worker's 1 s tick

    const jobs = readJobs(dataDir);
    expect(jobs.get(ids.due)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(jobs.get(ids.running)).toMatchObject({ status: 'running', attempts: 0 });
    expect(jobs.has(ids.oldDone)).toBe(true);
    expect(srv.output()).toContain('WORKER_ENABLED=false');

    srv.child.kill('SIGTERM');
    expect(await srv.exited).toBe(0);
    expect(srv.output()).toContain('shutting down');
  }, 30_000);

  it('by default runs the worker and retention, and stops cleanly on SIGTERM', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hdc-server-test-'));
    dirs.push(dataDir);
    const ids = seed(dataDir);
    const srv = startServer(dataDir, {});
    await srv.listening;
    await new Promise((r) => setTimeout(r, 1500));

    const jobs = readJobs(dataDir);
    // No handler for the type, so each was tried once and will be retried.
    expect(jobs.get(ids.due)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(jobs.get(ids.running)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(jobs.has(ids.oldDone)).toBe(false);

    srv.child.kill('SIGTERM');
    expect(await srv.exited).toBe(0);
  }, 30_000);
});
