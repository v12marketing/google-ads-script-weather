import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';

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

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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

  // Claims and runs due jobs one at a time until none are due. Returns how many ran.
  async runDue(limit = 50): Promise<number> {
    let ran = 0;
    while (ran < limit) {
      const job = this.claimNext();
      if (!job) break;
      ran++;
      await this.execute(job);
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      const dead = attempts >= MAX_ATTEMPTS || err instanceof PermanentJobError;
      const runAt = new Date(Date.now() + backoffMs(attempts)).toISOString();
      this.db
        .prepare(`UPDATE jobs SET status = ?, attempts = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?`)
        .run(dead ? 'dead' : 'pending', attempts, message.slice(0, 4000), runAt, nowIso(), job.id);
      this.log[dead ? 'error' : 'warn']({ jobId: job.id, type: job.type, attempts, err: message.split('\n')[0] }, dead ? 'job failed permanently' : 'job failed, will retry');
    }
  }
}

// Thrown when retrying cannot help (bad input, missing config). The job goes straight to dead.
export class PermanentJobError extends Error {}
