import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pino from 'pino';
import { loadConfig } from './config.js';
import { loadBoardConfig } from './board-config.js';
import { buildContext } from './context.js';
import { buildApp } from './web/app.js';
import { MondayClient } from './adapters/monday/client.js';
import { HighLevelClient } from './adapters/highlevel/client.js';
import { DiskFileStore } from './services/storage.js';
import { JOB } from './services/contracts.js';
import { pruneOldRecords, STOP_TIMEOUT_MS } from './services/jobs.js';

// Bad or missing settings stop the process at once with a readable message.
function loadSettings() {
  try {
    const config = loadConfig();
    return { config, board: loadBoardConfig(config.BOARD_CONFIG_PATH) };
  } catch (err) {
    console.error(`Startup failed. ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const { config, board } = loadSettings();
const log = pino({ level: config.LOG_LEVEL });

const ctx = buildContext({
  config,
  board,
  monday: new MondayClient(config),
  highlevel: new HighLevelClient(config),
  store: new DiskFileStore(join(config.DATA_DIR, 'files')),
  log,
});

const app = await buildApp(ctx);

// The worker: the job queue and the periodic tasks. Off (WORKER_ENABLED=false)
// only when trying a restored backup elsewhere: queued jobs then just wait.
const timers: NodeJS.Timeout[] = [];
if (config.WORKER_ENABLED) {
  ctx.jobs.start();

  // Safety net for missed "document signed" webhooks.
  const RECONCILE_EVERY_MS = 15 * 60 * 1000;
  timers.push(
    setInterval(() => {
      const bucket = Math.floor(Date.now() / RECONCILE_EVERY_MS);
      ctx.jobs.enqueue(JOB.settlementReconcile, {}, { dedupeKey: `settlement-reconcile:${bucket}` });
    }, RECONCILE_EVERY_MS).unref(),
  );

  // Retention: old finished jobs and webhook delivery ids (periods in jobs.ts).
  const prune = () => {
    try {
      const deleted = pruneOldRecords(ctx.jobs, ctx.repo);
      if (deleted.jobs || deleted.deliveryKeys) log.info(deleted, 'retention: old records deleted');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'retention failed');
    }
  };
  prune();
  timers.push(setInterval(prune, 60 * 60 * 1000).unref());
} else {
  log.warn('WORKER_ENABLED=false: background jobs and periodic tasks are not running');
}

// docker compose sends SIGTERM on every update and restart. Stop taking jobs,
// let the one in progress finish (so a message isn't sent twice after the
// restart) and the open requests complete, then close the database. Compose
// waits 30 s (stop_grace_period) before it kills the process.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'shutting down');
    timers.forEach(clearInterval);
    const [idle] = await Promise.all([
      ctx.jobs.stop(STOP_TIMEOUT_MS),
      Promise.race([
        app.close().catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err) }, 'closing the server failed')),
        delay(STOP_TIMEOUT_MS, undefined, { ref: false }),
      ]),
    ]);
    if (!idle) log.warn('a job was still running at shutdown; it runs again on the next start');
    ctx.db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
