import { join } from 'node:path';
import pino from 'pino';
import { loadConfig } from './config.js';
import { loadBoardConfig } from './board-config.js';
import { buildContext } from './context.js';
import { buildApp } from './web/app.js';
import { MondayClient } from './adapters/monday/client.js';
import { HighLevelClient } from './adapters/highlevel/client.js';
import { DiskFileStore } from './services/storage.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const board = loadBoardConfig(config.BOARD_CONFIG_PATH);

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
