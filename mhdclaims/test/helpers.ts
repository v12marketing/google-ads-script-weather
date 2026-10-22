import { parseBoardConfig, type BoardConfig } from '../src/board-config.js';
import { testConfig, type AppConfig } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { openDb } from '../src/db/index.js';
import { FakeHighLevel } from '../src/adapters/highlevel/fake.js';
import { FakeMonday } from '../src/adapters/monday/fake.js';
import { MemoryFileStore } from '../src/services/storage.js';
import type { AppContext } from '../src/services/contracts.js';
import boardExample from '../config/board.example.json' with { type: 'json' };

export const silentLog = { info() {}, warn() {}, error() {} };

export interface TestEnv {
  ctx: AppContext;
  monday: FakeMonday;
  highlevel: FakeHighLevel;
  store: MemoryFileStore;
  board: BoardConfig;
  config: AppConfig;
}

export function makeTestEnv(opts: { config?: Partial<AppConfig>; board?: Partial<BoardConfig> } = {}): TestEnv {
  const config = testConfig(opts.config);
  const board = parseBoardConfig({ ...structuredClone(boardExample), ...opts.board });
  const monday = new FakeMonday(config.MONDAY_INTEGRATION_USER_ID);
  const highlevel = new FakeHighLevel();
  const store = new MemoryFileStore();
  const ctx = buildContext({ config, board, monday, highlevel, store, log: silentLog, db: openDb(':memory:') });
  return { ctx, monday, highlevel, store, board, config };
}

// Adds an item shaped like a claim-form submission to the fake claims board.
export function addClaimItem(
  env: TestEnv,
  o: { name?: string; email?: string; phone?: string; smsOptIn?: boolean; status?: string; amount?: number } = {},
) {
  const c = env.board.columns;
  return env.monday.addItem(env.board.claimsBoardId, o.name ?? 'Jane Doe', {
    [c.email]: { type: 'email', text: o.email ?? 'jane@example.com' },
    [c.phone]: { type: 'phone', text: o.phone ?? '+16035550100' },
    [c.smsOptIn]: { type: 'checkbox', text: o.smsOptIn === false ? '' : 'v', value: o.smsOptIn === false ? null : '{"checked":"true"}' },
    [c.status]: { type: 'status', text: o.status ?? 'New' },
    ...(c.amountClaimed ? { [c.amountClaimed]: { type: 'numbers', text: String(o.amount ?? 1250) } } : {}),
  });
}
