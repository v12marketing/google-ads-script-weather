import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';
import type { Repo } from '../db/repo.js';
import { MondayApiError } from '../adapters/monday/client.js';

// A small durable job queue in SQLite. Webhooks enqueue and return 200 at once;
// the worker does the API calls and retries with backoff when Monday or
// HighLevel is slow or down.

export type JobHandler = (payload: any) => Promise<void>;

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface JobRow {
  id: number;
  type: string;
  payload: string;
  dedupe_key: string | null;
  status: 'pending' | 'running' | 'done' | 'dead';
  attempts: number;
  run_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_ATTEMPTS = 8;

// 10s, 30s, 1.5m, 4.5m, ... capped at 1h.
export const backoffMs = (attempt: number): number => Math.min(10_000 * 3 ** (attempt - 1), 60 * 60 * 1000);

// Thrown by a handler when the API said when to try again. Monday errors that
// carry the same information (see retryHintMs) don't need wrapping.
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly retryInMs: number,
  ) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

// A job the API asked to wait waits that long without using up an attempt, so
// e.g. Monday's daily call limit (it resets at 00:00 UTC, hours after the
// backoff above would give up) doesn't kill every job that touches Monday.
// Limits: one wait is at most MAX_RETRY_HINT_MS, and once a job is older than
// MAX_DEFER_AGE_MS its failures count as usual, so it can't wait forever.
export const MAX_RETRY_HINT_MS = 25 * 60 * 60 * 1000;
export const MAX_DEFER_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Retry 5 to 10 minutes after Monday's daily reset, not on the stroke of midnight.
export const DAILY_RESET_MARGIN_MS = 5 * 60 * 1000;

export const nextUtcMidnight = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

// How long the error says to wait before retrying, or null for the usual backoff.
// Looks through wrapped errors (`cause`) too.
export function retryHintMs(err: unknown, now = Date.now()): number | null {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++, e = e.cause) {
    if (e instanceof RetryLaterError) return e.retryInMs;
    if (e instanceof MondayApiError) {
      const givenMs = e.retryInSeconds !== null && e.retryInSeconds > 0 ? e.retryInSeconds * 1000 : 0;
      if (e.code === 'DAILY_LIMIT_EXCEEDED') {
        const reset = nextUtcMidnight(now) - now + DAILY_RESET_MARGIN_MS + Math.floor(Math.random() * DAILY_RESET_MARGIN_MS);
        return Math.max(reset, givenMs);
      }
      if (givenMs) return givenMs;
    }
  }
  return null;
}

// Retention (pruneOldRecords). Finished jobs keep their payloads, which can hold
// Monday update text and claimant messages, so they go after a week; dead jobs
// stay for /admin. Webhook delivery ids only need to outlive redeliveries.
export const DONE_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DELIVERY_KEY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// processed_events keys that are webhook delivery ids (webhooks.ts). Every other
// key there (notifier 'sent:*', 'status:*', one-time notes, ...) must stay for
// the life of the claim, or a retry or a late redelivery would repeat a message.
export const DELIVERY_KEY_PREFIXES = ['monday:'] as const;

// Waits for the job in progress at most this long when the process stops
// (docker compose allows 30 s, stop_grace_period in deploy/docker-compose.yml).
export const STOP_TIMEOUT_MS = 25_000;

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Set by stop(): no new job is claimed. The job in progress, if any, is `active`.
  private stopping = false;
  private active: Promise<void> | null = null;

  constructor(
    private db: Db,
    private log: Logger,
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  // Jobs with the same dedupeKey are only queued once; returns false if it already existed.
  enqueue(type: string, payload: unknown, opts: { dedupeKey?: string; delayMs?: number } = {}): boolean {
    const now = nowIso();
    const runAt = new Date(Date.now() + (opts.delayMs ?? 0)).toISOString();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (type, payload, dedupe_key, run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(type, JSON.stringify(payload), opts.dedupeKey ?? null, runAt, now, now);
    return res.changes === 1;
  }

  // Claims and runs due jobs one at a time until none are due (or stop() is
  // called). Returns how many ran.
  async runDue(limit = 50): Promise<number> {
    let ran = 0;
    while (ran < limit && !this.stopping) {
      const job = this.claimNext();
      if (!job) break;
      ran++;
      this.active = this.execute(job);
      try {
        await this.active;
      } finally {
        this.active = null;
      }
    }
    return ran;
  }

  // Runs everything due now, including jobs those jobs enqueue. For tests.
  async drain(maxRounds = 20): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.runDue()) === 0) return;
    }
  }

  start(intervalMs = 1000): void {
    this.stopping = false;
    // Jobs left 'running' by a crash are picked up again.
    this.db.prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`).run();
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runDue();
      } catch (err) {
        this.log.error({ err }, 'job worker tick failed');
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  // Stops claiming jobs and waits for the one in progress, so its external calls
  // are recorded before the process exits. Resolves true once nothing is running,
  // false if a job was still running after timeoutMs (it stays 'running' and is
  // run again on the next start).
  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const active = this.active;
    if (!active) return true;
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([active.then(() => true), timedOut]);
    } finally {
      clearTimeout(timeout);
    }
  }

  list(status?: JobRow['status'], limit = 100): JobRow[] {
    return (
      status
        ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
        : this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit)
    ) as JobRow[];
  }

  retry(id: number): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, updated_at = ? WHERE id = ? AND status = 'dead'`)
      .run(nowIso(), nowIso(), id);
  }

  // Deletes jobs that finished more than DONE_JOB_RETENTION_MS ago. Returns how many.
  pruneDone(now = Date.now()): number {
    const before = new Date(now - DONE_JOB_RETENTION_MS).toISOString();
    return this.db.prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`).run(before).changes;
  }

  private claimNext(): JobRow | null {
    return this.db.transaction(() => {
      const job = this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 1`)
        .get(nowIso()) as JobRow | undefined;
      if (!job) return null;
      this.db.prepare(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?`).run(nowIso(), job.id);
      return job;
    })();
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    const attempts = job.attempts + 1;
    try {
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      await handler(JSON.parse(job.payload));
      this.db
        .prepare(`UPDATE jobs SET status = 'done', attempts = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(attempts, nowIso(), job.id);
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      const now = Date.now();
      const hint = err instanceof PermanentJobError ? null : retryHintMs(err, now);
      if (hint !== null && now - Date.parse(job.created_at) < MAX_DEFER_AGE_MS) {
        // Not counted as an attempt: the API told us when it will work again.
        const runAt = new Date(now + Math.min(Math.max(hint, 1000), MAX_RETRY_HINT_MS)).toISOString();
        this.db
          .prepare(`UPDATE jobs SET status = 'pending', last_error = ?, run_at = ?, updated_at = ? WHERE id = ?`)
          .run(message.slice(0, 4000), runAt, nowIso(), job.id);
        this.log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, runAt, err: message.split('\n')[0] }, 'job postponed until the API allows it');
        return;
      }
      const dead = attempts >= MAX_ATTEMPTS || err instanceof PermanentJobError;
      const runAt = new Date(now + backoffMs(attempts)).toISOString();
      this.db
        .prepare(`UPDATE jobs SET status = ?, attempts = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?`)
        .run(dead ? 'dead' : 'pending', attempts, message.slice(0, 4000), runAt, nowIso(), job.id);
      this.log[dead ? 'error' : 'warn']({ jobId: job.id, type: job.type, attempts, err: message.split('\n')[0] }, dead ? 'job failed permanently' : 'job failed, will retry');
    }
  }
}

// Thrown when retrying cannot help (bad input, missing config). The job goes straight to dead.
export class PermanentJobError extends Error {}

// Retention, run hourly by the worker (server.ts): deletes finished jobs older
// than DONE_JOB_RETENTION_MS and webhook delivery ids older than
// DELIVERY_KEY_RETENTION_MS. Returns how many of each.
export function pruneOldRecords(
  jobs: JobQueue,
  repo: Pick<Repo, 'deleteProcessedEventsBefore'>,
  now = Date.now(),
): { jobs: number; deliveryKeys: number } {
  const before = new Date(now - DELIVERY_KEY_RETENTION_MS).toISOString();
  let deliveryKeys = 0;
  for (const prefix of DELIVERY_KEY_PREFIXES) deliveryKeys += repo.deleteProcessedEventsBefore(prefix, before);
  return { jobs: jobs.pruneDone(now), deliveryKeys };
}
