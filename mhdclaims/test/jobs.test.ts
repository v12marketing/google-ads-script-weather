import { afterEach, describe, expect, it, vi } from 'vitest';
import { MondayApiError } from '../src/adapters/monday/client.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import {
  DAILY_RESET_MARGIN_MS,
  JobQueue,
  MAX_ATTEMPTS,
  MAX_RETRY_HINT_MS,
  PermanentJobError,
  RetryLaterError,
  pruneOldRecords,
  type JobRow,
} from '../src/services/jobs.js';
import { silentLog } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const db = openDb(':memory:');
  return { db, jobs: new JobQueue(db, silentLog), repo: new Repo(db) };
}

const rowOf = (db: ReturnType<typeof openDb>, id: number) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
const lastId = (db: ReturnType<typeof openDb>) => (db.prepare('SELECT MAX(id) AS id FROM jobs').get() as { id: number }).id;
const dailyLimit = () =>
  new MondayApiError('Monday query failed: HTTP 200 DAILY_LIMIT_EXCEEDED: Daily limit exceeded', 200, 'DAILY_LIMIT_EXCEEDED', null);

// Makes the job due again now, as if the clock had reached its run_at.
const makeDue = (db: ReturnType<typeof openDb>, id: number) =>
  db.prepare('UPDATE jobs SET run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);

afterEach(() => {
  vi.useRealTimers();
});

describe('JobQueue retry hints', () => {
  it("parks a job on Monday's daily limit until just after 00:00 UTC without using an attempt", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T15:00:00Z'));
    const { db, jobs } = setup();
    jobs.register('t', async () => {
      throw dailyLimit();
    });
    jobs.enqueue('t', {});
    const id = lastId(db);

    await jobs.runDue();
    const row = rowOf(db, id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toContain('DAILY_LIMIT_EXCEEDED');
    const runAt = Date.parse(row.run_at);
    const midnight = Date.parse('2026-10-23T00:00:00Z');
    expect(runAt).toBeGreaterThanOrEqual(midnight + DAILY_RESET_MARGIN_MS);
    expect(runAt).toBeLessThanOrEqual(midnight + 2 * DAILY_RESET_MARGIN_MS);

    // However often the limit is hit (more than the 8 attempts the backoff allows), the job never dies of it.
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      makeDue(db, id);
      await jobs.runDue();
    }
    expect(rowOf(db, id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('runs the parked job once the limit has reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T23:59:00Z'));
    const { db, jobs } = setup();
    let fail = true;
    const ran: unknown[] = [];
    jobs.register('t', async (p) => {
      if (fail) throw dailyLimit();
      ran.push(p);
    });
    jobs.enqueue('t', { n: 1 });
    const id = lastId(db);
    await jobs.runDue();
    expect(Date.parse(rowOf(db, id).run_at)).toBeGreaterThan(Date.parse('2026-10-23T00:00:00Z'));

    vi.setSystemTime(new Date('2026-10-23T00:04:00Z'));
    expect(await jobs.runDue()).toBe(0); // not before the margin
    vi.setSystemTime(new Date('2026-10-23T00:11:00Z'));
    fail = false;
    await jobs.runDue();
    expect(ran).toEqual([{ n: 1 }]);
    expect(rowOf(db, id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it("uses Monday's retry_in_seconds when given, capped, and looks through wrapped errors", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-10-22T15:00:00Z');
    vi.setSystemTime(now);
    const { db, jobs } = setup();
    const errors: Record<string, Error> = {
      rate: new MondayApiError('rate limited', 429, 'RATE_LIMIT_EXCEEDED', 40),
      huge: new MondayApiError('rate limited', 429, 'COMPLEXITY_BUDGET_EXHAUSTED', 30 * 24 * 3600),
      wrapped: new Error('intake failed', { cause: new MondayApiError('rate limited', 429, 'RATE_LIMIT_EXCEEDED', 60) }),
      own: new RetryLaterError('come back later', 120_000),
    };
    const ids: Record<string, number> = {};
    for (const [name, err] of Object.entries(errors)) {
      jobs.register(name, async () => {
        throw err;
      });
      jobs.enqueue(name, {});
      ids[name] = lastId(db);
    }
    await jobs.runDue();
    const delay = (name: string) => Date.parse(rowOf(db, ids[name]!).run_at) - now.getTime();
    expect(delay('rate')).toBe(40_000);
    expect(delay('huge')).toBe(MAX_RETRY_HINT_MS);
    expect(delay('wrapped')).toBe(60_000);
    expect(delay('own')).toBe(120_000);
    for (const id of Object.values(ids)) expect(rowOf(db, id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('counts attempts as usual once the job is days old, so it cannot wait forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T15:00:00Z'));
    const { db, jobs } = setup();
    jobs.register('t', async () => {
      throw dailyLimit();
    });
    jobs.enqueue('t', {});
    const id = lastId(db);
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 4 * DAY).toISOString(), id);
    await jobs.runDue();
    const row = rowOf(db, id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Date.parse(row.run_at) - Date.now()).toBe(10_000);
  });

  it('keeps the usual backoff and dead-lettering for other errors', async () => {
    const { db, jobs } = setup();
    jobs.register('plain', async () => {
      throw new MondayApiError('Monday query failed: HTTP 500', 500, null, null);
    });
    jobs.register('permanent', async () => {
      throw new PermanentJobError('bad input');
    });
    jobs.enqueue('plain', {});
    const plain = lastId(db);
    jobs.enqueue('permanent', {});
    const permanent = lastId(db);
    await jobs.runDue();
    expect(rowOf(db, plain)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(rowOf(db, permanent)).toMatchObject({ status: 'dead', attempts: 1 });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      makeDue(db, plain);
      await jobs.runDue();
    }
    expect(rowOf(db, plain)).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS });
  });
});

describe('JobQueue.stop', () => {
  it('stops claiming new jobs and waits for the one in progress', async () => {
    const { db, jobs } = setup();
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const calls: number[] = [];
    jobs.register('slow', async (p: { n: number }) => {
      calls.push(p.n);
      started();
      await new Promise<void>((r) => (release = r));
    });
    jobs.enqueue('slow', { n: 1 });
    const first = lastId(db);
    jobs.enqueue('slow', { n: 2 });
    const second = lastId(db);

    jobs.start(5);
    await startedP;
    let stopped: boolean | undefined;
    const stopping = jobs.stop(5000).then((v) => (stopped = v));
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBeUndefined(); // still waiting for job 1
    release();
    await stopping;

    expect(stopped).toBe(true);
    expect(calls).toEqual([1]);
    expect(rowOf(db, first).status).toBe('done');
    expect(rowOf(db, second)).toMatchObject({ status: 'pending', attempts: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([1]); // the stopped worker never picks job 2 up
  });

  it('gives up waiting after the timeout; the job stays running and is picked up on the next start', async () => {
    const { db, jobs } = setup();
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    jobs.register('stuck', async () => {
      started();
      await new Promise(() => {});
    });
    jobs.enqueue('stuck', {});
    const id = lastId(db);
    jobs.start(5);
    await startedP;
    expect(await jobs.stop(50)).toBe(false);
    expect(rowOf(db, id).status).toBe('running');

    const next = new JobQueue(db, silentLog);
    next.register('stuck', async () => {});
    next.start(5);
    await new Promise((r) => setTimeout(r, 50));
    expect(await next.stop()).toBe(true);
    expect(rowOf(db, id).status).toBe('done');
  });

  it('resolves at once when nothing is running', async () => {
    const { jobs } = setup();
    jobs.start(1000);
    expect(await jobs.stop(10_000)).toBe(true);
  });
});

describe('pruneOldRecords', () => {
  it('deletes week-old finished jobs and 90-day-old webhook delivery ids, and nothing else', () => {
    const { db, jobs, repo } = setup();
    const now = Date.parse('2026-10-22T12:00:00Z');
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    const job = (status: string, updatedDaysAgo: number) => {
      db.prepare(
        `INSERT INTO jobs (type, payload, status, run_at, created_at, updated_at) VALUES ('monday.update_created', '{"textBody":"internal note"}', ?, ?, ?, ?)`,
      ).run(status, ago(updatedDaysAgo), ago(updatedDaysAgo), ago(updatedDaysAgo));
      return lastId(db);
    };
    const oldDone = job('done', 8);
    const recentDone = job('done', 6);
    const oldDead = job('dead', 60);
    const oldPending = job('pending', 30);

    const event = (key: string, daysAgo: number) =>
      db.prepare('INSERT INTO processed_events (event_key, created_at) VALUES (?, ?)').run(key, ago(daysAgo));
    event('monday:old-delivery', 91);
    event('monday:recent-delivery', 89);
    // Keys that must last as long as the claim: a lost one would repeat a message.
    event('sent:confirmation:1:email', 400);
    event('status:abc', 400);
    event('confirmation:1', 400);
    event('intake-done:1', 400);
    event('settlement-signed:1:doc', 400);

    expect(pruneOldRecords(jobs, repo, now)).toEqual({ jobs: 1, deliveryKeys: 1 });

    const remainingJobs = (db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
    expect(remainingJobs).toEqual([recentDone, oldDead, oldPending]);
    expect(remainingJobs).not.toContain(oldDone);
    const keys = (db.prepare('SELECT event_key FROM processed_events ORDER BY event_key').all() as Array<{ event_key: string }>).map((r) => r.event_key);
    expect(keys).toEqual([
      'confirmation:1',
      'intake-done:1',
      'monday:recent-delivery',
      'sent:confirmation:1:email',
      'settlement-signed:1:doc',
      'status:abc',
    ]);
    // Idempotent.
    expect(pruneOldRecords(jobs, repo, now)).toEqual({ jobs: 0, deliveryKeys: 0 });
  });
});
