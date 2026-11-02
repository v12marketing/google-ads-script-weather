import type { AppConfig } from './config.js';
import type { BoardConfig } from './board-config.js';
import { openDb, type Db } from './db/index.js';
import { Repo } from './db/repo.js';
import type { HighLevelApi } from './adapters/highlevel/types.js';
import type { MondayApi } from './adapters/monday/types.js';
import { JobQueue, type Logger } from './services/jobs.js';
import type { AppContext, CoreContext, Services } from './services/contracts.js';
import type { FileStore } from './services/storage.js';
import { createTokenService } from './services/tokens.js';
import { createTemplateService } from './services/templates.js';
import { createNotifier } from './services/notifier.js';
import { createIntakeService } from './services/intake.js';
import { createStatusService } from './services/status.js';
import { createSettlementService } from './services/settlement.js';
import { createPaymentService } from './services/payment.js';
import { createMessagingService } from './services/messaging.js';
import { createFileService } from './services/files.js';
import { createAuthService } from './services/auth.js';
import { registerJobHandlers } from './services/handlers.js';

export interface ContextDeps {
  config: AppConfig;
  board: BoardConfig;
  monday: MondayApi;
  highlevel: HighLevelApi;
  store: FileStore;
  log: Logger;
  db?: Db;
}

// Wires the services together. Factories receive the shared `services` object
// and may call each other at runtime (never during construction).
export function buildContext(deps: ContextDeps): AppContext {
  const db = deps.db ?? openDb(deps.config.DATA_DIR);
  const core: CoreContext = {
    config: deps.config,
    board: deps.board,
    db,
    repo: new Repo(db),
    jobs: new JobQueue(db, deps.log),
    monday: deps.monday,
    highlevel: deps.highlevel,
    store: deps.store,
    log: deps.log,
  };
  const services = {} as Services;
  services.tokens = createTokenService(core);
  services.templates = createTemplateService(core, services);
  services.notifier = createNotifier(core, services);
  services.intake = createIntakeService(core, services);
  services.status = createStatusService(core, services);
  services.settlement = createSettlementService(core, services);
  services.payment = createPaymentService(core, services);
  services.messaging = createMessagingService(core, services);
  services.files = createFileService(core, services);
  services.auth = createAuthService(core, services);

  const ctx: AppContext = { ...core, services };
  registerJobHandlers(ctx);
  return ctx;
}
