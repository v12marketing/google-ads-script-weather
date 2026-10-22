// Monday.com setup helper. Run from the project root with tsx:
//
//   npx tsx scripts/monday-setup.ts check              check config/board.json against the live boards
//   npx tsx scripts/monday-setup.ts webhooks           register our webhooks (safe to re-run)
//   npx tsx scripts/monday-setup.ts webhooks --delete  remove the webhooks we registered
//
// Settings come from the environment, plus ./.env if present (it never overrides
// variables already set). Created webhook ids are kept in DATA_DIR/monday-webhooks.json:
// Monday's Webhook type has no url field, so listing a board can't tell ours apart.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';
import { loadBoardConfig, statusKeyForLabel, visibleFileColumns, type BoardConfig } from '../src/board-config.js';
import { MondayClient } from '../src/adapters/monday/client.js';

const BOARDS = 'query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type settings } } }';
const ME = 'query { me { id name } }';
const USERS = 'query ($ids: [ID!]) { users(ids: $ids) { id name } }';
const LIST_WEBHOOKS = 'query ($boardId: ID!) { webhooks(board_id: $boardId) { id event board_id } }';
const CREATE_WEBHOOK =
  'mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) { create_webhook(board_id: $boardId, url: $url, event: $event, config: $config) { id } }';
const DELETE_WEBHOOK = 'mutation ($id: ID!) { delete_webhook(id: $id) { id } }';

interface Column {
  id: string;
  title: string;
  type: string;
  settings: unknown;
}
interface Board {
  id: string;
  name: string;
  columns: Column[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

class Report {
  problems = 0;
  heading(text: string) {
    console.log(`\n${text}`);
  }
  ok(text: string) {
    console.log(`  ok    ${text}`);
  }
  fail(text: string) {
    this.problems++;
    console.log(`  FAIL  ${text}`);
  }
  note(text: string) {
    console.log(`  note  ${text}`);
  }
}

// Status labels from Column.settings (API 2025-10+: labels[] with id, index,
// label, is_deactivated). Also accepts the older { labels: { "<id>": "text" } } map.
function statusLabels(settings: unknown): Array<{ text: string; deactivated: boolean }> | null {
  let s = settings;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  const labels = isObj(s) ? s.labels : undefined;
  let out: Array<{ text: string; deactivated: boolean }> = [];
  if (Array.isArray(labels)) {
    out = labels.filter(isObj).map((l) => ({
      text: String(l.label ?? l.name ?? l.text ?? ''),
      deactivated: l.is_deactivated === true,
    }));
  } else if (isObj(labels)) {
    out = Object.values(labels).map((t) => ({ text: String(t), deactivated: false }));
  }
  // An unrecognised shape would otherwise read as "every label missing".
  return out.some((l) => l.text) ? out : null;
}

async function fetchBoards(client: MondayClient, ids: string[]): Promise<Map<string, Board>> {
  const data = await client.query<{ boards: Board[] | null }>(BOARDS, { ids }, 'boards');
  return new Map((data.boards ?? []).map((b) => [String(b.id), b]));
}

function checkColumns(r: Report, board: Board, expected: Array<{ key: string; columnId: string | undefined; types: string[] }>) {
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  for (const e of expected) {
    if (!e.columnId) {
      r.note(`${e.key} not configured`);
      continue;
    }
    const col = byId.get(e.columnId);
    if (!col) r.fail(`${e.key}: column "${e.columnId}" not found on the board`);
    else if (!e.types.includes(col.type)) r.fail(`${e.key}: column "${e.columnId}" (${col.title}) is type ${col.type}, expected ${e.types.join(' or ')}`);
    else r.ok(`${e.key}: "${e.columnId}" (${col.title}, ${col.type})`);
  }
}

// Checks that each label exists (and is active) on the status column. Returns the board's labels.
function checkLabels(r: Report, board: Board, columnId: string, wanted: Array<{ label: string; why: string }>): string[] {
  const col = board.columns.find((c) => c.id === columnId);
  if (!col) return [];
  const labels = statusLabels(col.settings);
  if (!labels) {
    r.fail(`could not read the labels of status column "${columnId}"`);
    return [];
  }
  for (const w of wanted) {
    const found = labels.find((l) => norm(l.text) === norm(w.label));
    if (!found) r.fail(`label "${w.label}" (${w.why}) is not on status column "${columnId}"`);
    else if (found.deactivated) r.fail(`label "${w.label}" (${w.why}) is deactivated on status column "${columnId}"`);
    else r.ok(`label "${w.label}" (${w.why})`);
  }
  return labels.filter((l) => l.text && !l.deactivated).map((l) => l.text);
}

async function check(client: MondayClient, config: AppConfig, cfg: BoardConfig): Promise<number> {
  const r = new Report();

  r.heading(`Monday API (version ${config.MONDAY_API_VERSION})`);
  const { me } = await client.query<{ me: { id: string; name: string } | null }>(ME, {}, 'me');
  if (!me) r.fail('the API token did not resolve to a user');
  else if (String(me.id) !== config.MONDAY_INTEGRATION_USER_ID) {
    r.fail(`the token belongs to user ${me.id} (${me.name}) but MONDAY_INTEGRATION_USER_ID is ${config.MONDAY_INTEGRATION_USER_ID}; our own updates would echo back`);
  } else r.ok(`token user ${me.id} (${me.name}) matches MONDAY_INTEGRATION_USER_ID`);

  const boardIds = [cfg.claimsBoardId, ...(cfg.paymentBoard ? [cfg.paymentBoard.boardId] : [])];
  const boards = await fetchBoards(client, boardIds);

  const claims = boards.get(cfg.claimsBoardId);
  r.heading(`Claims board ${cfg.claimsBoardId}${claims ? ` "${claims.name}"` : ''}`);
  if (!claims) r.fail(`board not found, or the token's user cannot see it`);
  else {
    const c = cfg.columns;
    checkColumns(r, claims, [
      { key: 'columns.claimNumber', columnId: c.claimNumber, types: ['text'] },
      { key: 'columns.status', columnId: c.status, types: ['status', 'color'] },
      { key: 'columns.email', columnId: c.email, types: ['email'] },
      { key: 'columns.phone', columnId: c.phone, types: ['phone'] },
      { key: 'columns.smsOptIn', columnId: c.smsOptIn, types: ['checkbox'] },
      { key: 'columns.amountClaimed', columnId: c.amountClaimed, types: ['numbers'] },
      { key: 'columns.settlementAmount', columnId: c.settlementAmount, types: ['numbers'] },
      { key: 'columns.dateReceived', columnId: c.dateReceived, types: ['date'] },
      { key: 'columns.portalLink', columnId: c.portalLink, types: ['text'] },
      { key: 'columns.intakePhotos', columnId: c.intakePhotos, types: ['file'] },
      { key: 'columns.claimantUploads', columnId: c.claimantUploads, types: ['file'] },
      { key: 'columns.signedSettlement', columnId: c.signedSettlement, types: ['file'] },
      ...cfg.sharedFileColumns.map((id, i) => ({ key: `sharedFileColumns[${i}]`, columnId: id, types: ['file'] })),
    ]);

    r.heading(`Status labels (column "${c.status}")`);
    const boardLabels = checkLabels(r, claims, c.status, [
      ...Object.entries(cfg.statuses).map(([label, key]) => ({ label, why: `-> ${key}` })),
      { label: cfg.settlementSignedLabel, why: 'settlementSignedLabel, set by the integration' },
    ]);
    if (statusKeyForLabel(cfg, cfg.settlementSignedLabel) !== 'settlement_signed') {
      r.note(`settlementSignedLabel "${cfg.settlementSignedLabel}" is not mapped to settlement_signed in "statuses", so signing sends no status message`);
    }
    const internal = boardLabels.filter((l) => !statusKeyForLabel(cfg, l));
    if (internal.length) r.note(`internal labels (no claimant message): ${internal.map((l) => `"${l}"`).join(', ')}`);
  }

  const pb = cfg.paymentBoard;
  if (pb) {
    const payment = boards.get(pb.boardId);
    r.heading(`Payment board ${pb.boardId}${payment ? ` "${payment.name}"` : ''}`);
    if (!payment) r.fail(`board not found, or the token's user cannot see it`);
    else {
      checkColumns(r, payment, [
        { key: 'paymentBoard.claimNumberColumn', columnId: pb.claimNumberColumn, types: ['text'] },
        { key: 'paymentBoard.signatureColumn', columnId: pb.signatureColumn, types: ['text'] },
        { key: 'paymentBoard.verificationColumn', columnId: pb.verificationColumn, types: ['status', 'color'] },
      ]);
      checkLabels(r, payment, pb.verificationColumn, [
        { label: pb.verifiedLabel, why: 'verifiedLabel' },
        { label: pb.mismatchLabel, why: 'mismatchLabel' },
      ]);
    }
  } else {
    r.heading('Payment board');
    r.note('paymentBoard not configured; payment submissions will not be verified');
  }

  r.heading('Notified users');
  if (cfg.notifyUserIds.length === 0) r.note('notifyUserIds is empty; nobody is notified of claimant messages');
  else {
    const { users } = await client.query<{ users: Array<{ id: string; name: string }> | null }>(USERS, { ids: cfg.notifyUserIds }, 'users');
    const found = new Map((users ?? []).map((u) => [String(u.id), u.name]));
    for (const id of cfg.notifyUserIds) {
      const name = found.get(id);
      if (name) r.ok(`user ${id} (${name})`);
      else r.fail(`notifyUserIds: user ${id} not found`);
    }
  }

  console.log(r.problems ? `\n${r.problems} problem(s) found.` : '\nAll checks passed.');
  return r.problems;
}

// --- webhooks ---

interface Wanted {
  key: string;
  boardId: string;
  event: string;
  columnId: string | null;
  config: Record<string, unknown> | null;
}
interface SavedHook {
  key: string;
  id: string;
  boardId: string;
  event: string;
  columnId: string | null;
  createdAt: string;
}
interface HookState {
  // SHA-256 of the URL the saved hooks point at (the URL itself contains WEBHOOK_SECRET).
  urlHash: string | null;
  webhooks: SavedHook[];
}

function wantedHooks(cfg: BoardConfig): Wanted[] {
  const claims = cfg.claimsBoardId;
  const status = cfg.columns.status;
  const list: Array<Omit<Wanted, 'key'>> = [
    { boardId: claims, event: 'create_item', columnId: null, config: null },
    // The only documented form of the status config.
    { boardId: claims, event: 'change_status_column_value', columnId: status, config: { columnId: status, columnValue: { $any$: true } } },
    ...visibleFileColumns(cfg).map(({ columnId }) => ({
      boardId: claims,
      event: 'change_specific_column_value',
      columnId,
      config: { columnId },
    })),
    { boardId: claims, event: 'create_update', columnId: null, config: null },
  ];
  // The payment board is subscribed to new items only; its bank-detail columns are never read.
  if (cfg.paymentBoard) list.push({ boardId: cfg.paymentBoard.boardId, event: 'create_item', columnId: null, config: null });
  return list.map((w) => ({ ...w, key: `${w.boardId}:${w.event}:${w.columnId ?? ''}` }));
}

function describeHook(cfg: BoardConfig, h: { boardId: string; event: string; columnId: string | null }): string {
  const board = h.boardId === cfg.claimsBoardId ? 'claims' : h.boardId === cfg.paymentBoard?.boardId ? 'payment' : `board ${h.boardId}`;
  return `${board} ${h.event}${h.columnId ? ` [${h.columnId}]` : ''}`;
}

function readState(path: string): HookState {
  if (!existsSync(path)) return { urlHash: null, webhooks: [] };
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObj(parsed) || !Array.isArray(parsed.webhooks)) throw new Error(`${path} is not a webhook state file`);
  return { urlHash: typeof parsed.urlHash === 'string' ? parsed.urlHash : null, webhooks: parsed.webhooks as SavedHook[] };
}

function writeState(path: string, state: HookState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// Monday refuses to create a webhook unless the URL echoes its challenge, so try that first.
async function preflight(url: string): Promise<string | null> {
  const challenge = randomUUID();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok && isObj(body) && body.challenge === challenge) return null;
    return res.ok ? 'it answered without echoing the challenge' : `it answered HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error && err.name === 'TimeoutError' ? 'the request timed out' : 'the request failed (is the service running and reachable?)';
  }
}

async function webhooks(client: MondayClient, config: AppConfig, cfg: BoardConfig, opts: { remove: boolean; skipPreflight: boolean }): Promise<number> {
  const url = `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/monday/${config.WEBHOOK_SECRET}`;
  const urlHash = createHash('sha256').update(url).digest('hex');
  const path = join(config.DATA_DIR, 'monday-webhooks.json');
  const state = readState(path);
  const wanted = opts.remove ? [] : wantedHooks(cfg);
  const save = () => writeState(path, state);

  console.log(`Webhook URL: ${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/monday/<WEBHOOK_SECRET>`);
  console.log(`State file:  ${path}\n`);

  // Which saved ids still exist on Monday (they disappear if someone deletes them in the UI).
  const live = new Set<string>();
  for (const boardId of new Set([...state.webhooks.map((h) => h.boardId), ...wanted.map((w) => w.boardId)])) {
    const data = await client.query<{ webhooks: Array<{ id: string }> | null }>(LIST_WEBHOOKS, { boardId }, 'webhooks');
    for (const w of data.webhooks ?? []) live.add(String(w.id));
  }

  // Remove saved hooks that are gone, no longer wanted, or point at an old URL.
  const urlChanged = state.urlHash !== null && state.urlHash !== urlHash;
  if (urlChanged && state.webhooks.length) console.log('PUBLIC_BASE_URL or WEBHOOK_SECRET changed: replacing the existing webhooks.');
  for (const saved of [...state.webhooks]) {
    const keep = !urlChanged && wanted.some((w) => w.key === saved.key);
    if (keep && live.has(saved.id)) continue;
    if (live.has(saved.id)) {
      await client.query(DELETE_WEBHOOK, { id: saved.id }, 'delete_webhook');
      console.log(`  deleted  ${describeHook(cfg, saved)} (id ${saved.id})`);
    } else {
      console.log(`  gone     ${describeHook(cfg, saved)} (id ${saved.id}) was already removed on Monday`);
    }
    state.webhooks = state.webhooks.filter((h) => h !== saved);
    save();
  }
  state.urlHash = state.webhooks.length || wanted.length ? urlHash : null;
  save();

  const missing = wanted.filter((w) => !state.webhooks.some((h) => h.key === w.key));
  if (missing.length && !opts.skipPreflight) {
    const problem = await preflight(url);
    if (problem) {
      console.error(`\nThe webhook URL did not answer Monday's challenge: ${problem}.`);
      console.error('Start the service at PUBLIC_BASE_URL first (or pass --skip-preflight).');
      return 1;
    }
  }

  for (const w of wanted) {
    const saved = state.webhooks.find((h) => h.key === w.key);
    if (saved) {
      console.log(`  ok       ${describeHook(cfg, w)} (id ${saved.id})`);
      continue;
    }
    const variables: Record<string, unknown> = { boardId: w.boardId, url, event: w.event };
    if (w.config) variables.config = JSON.stringify(w.config);
    const data = await client.query<{ create_webhook: { id: string } | null }>(CREATE_WEBHOOK, variables, 'create_webhook');
    const id = data.create_webhook?.id;
    if (!id) throw new Error(`create_webhook returned no id for ${describeHook(cfg, w)}`);
    state.webhooks.push({ key: w.key, id: String(id), boardId: w.boardId, event: w.event, columnId: w.columnId, createdAt: new Date().toISOString() });
    save();
    console.log(`  created  ${describeHook(cfg, w)} (id ${id})`);
  }

  console.log(opts.remove ? '\nAll our webhooks are removed.' : `\n${state.webhooks.length} webhook(s) registered.`);
  return 0;
}

const USAGE = `Usage:
  npx tsx scripts/monday-setup.ts check
  npx tsx scripts/monday-setup.ts webhooks [--skip-preflight]
  npx tsx scripts/monday-setup.ts webhooks --delete`;

async function main(argv: string[]): Promise<number> {
  const [command, ...flags] = argv;
  const known = new Set(['--delete', '--skip-preflight']);
  if ((command !== 'check' && command !== 'webhooks') || flags.some((f) => !known.has(f)) || (command === 'check' && flags.length)) {
    console.error(USAGE);
    return 2;
  }
  let config: AppConfig | null = null;
  try {
    if (existsSync('.env')) process.loadEnvFile('.env');
    config = loadConfig();
    const cfg = loadBoardConfig(config.BOARD_CONFIG_PATH);
    const client = new MondayClient(config);
    if (command === 'check') return (await check(client, config, cfg)) ? 1 : 0;
    return await webhooks(client, config, cfg, { remove: flags.includes('--delete'), skipPreflight: flags.includes('--skip-preflight') });
  } catch (err) {
    // Never print secrets, even inside an API error message.
    let message = err instanceof Error ? err.message : String(err);
    if (config) message = message.split(config.WEBHOOK_SECRET).join('<WEBHOOK_SECRET>').split(config.MONDAY_API_TOKEN).join('<token>');
    console.error(`\nError: ${message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
