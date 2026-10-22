import { join } from 'node:path';
import pino from 'pino';
import { loadConfig } from './config.js';
import { loadBoardConfig } from './board-config.js';
import { buildContext } from './context.js';
import { buildApp } from './web/app.js';
import { MondayClient } from './adapters/monday/client.js';
import { HighLevelClient } from './adapters/highlevel/client.js';
import { DiskFileStore } from './services/storage.js';
import { JOB } from './services/contracts.js';

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
ctx.jobs.start();

// Safety net for missed "document signed" webhooks.
const RECONCILE_EVERY_MS = 15 * 60 * 1000;
setInterval(() => {
  const bucket = Math.floor(Date.now() / RECONCILE_EVERY_MS);
  ctx.jobs.enqueue(JOB.settlementReconcile, {}, { dedupeKey: `settlement-reconcile:${bucket}` });
}, RECONCILE_EVERY_MS).unref();
await app.listen({ port: config.PORT, host: config.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info({ sig }, 'shutting down');
    ctx.jobs.stop();
    await app.close();
    ctx.db.close();
    process.exit(0);
  });
}
