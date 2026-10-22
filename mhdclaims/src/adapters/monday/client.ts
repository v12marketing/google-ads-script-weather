import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../../config.js';
import type { MondayApi, MondayAsset, MondayColumnValue, MondayItem, MondayUpdate, MondayWriteOptions } from './types.js';
import { htmlToText } from './webhook.js';

const API_URL = 'https://api.monday.com/v2';
const FILE_URL = 'https://api.monday.com/v2/file';
const TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 120_000;
// Rate-limit waits up to this long are absorbed inside the call; longer ones fail
// the job, which the queue retries with backoff.
const MAX_INLINE_WAIT_S = 10;

const RATE_LIMIT_CODES = new Set([
  'COMPLEXITY_BUDGET_EXHAUSTED',
  'ComplexityException',
  'RATE_LIMIT_EXCEEDED',
  'IP_RATE_LIMIT_EXCEEDED',
  'maxConcurrencyExceeded',
]);

export class MondayApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
    // Seconds Monday asked us to wait before retrying (rate limits), when given.
    readonly retryInSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'MondayApiError';
  }
}

export interface MondayClientOptions {
  // Extra attempts within one call for rate limits, timeouts and 5xx responses
  // (the latter only where a retry cannot apply a write twice).
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

// --- GraphQL documents. Values always travel as variables. ---

const ITEM_FIELDS = 'id name created_at board { id }';
const COLUMN_FIELDS = 'id type text value ... on FileValue { files { ... on FileAssetValue { asset_id name } } }';
const GET_ITEM = `query ($ids: [ID!]) { items(ids: $ids, limit: 1) { ${ITEM_FIELDS} column_values { ${COLUMN_FIELDS} } } }`;
const GET_ITEM_COLUMNS = `query ($ids: [ID!], $columnIds: [String!]) { items(ids: $ids, limit: 1) { ${ITEM_FIELDS} column_values(ids: $columnIds) { ${COLUMN_FIELDS} } } }`;
const GET_UPDATE = 'query ($ids: [ID!]) { updates(ids: $ids, limit: 1) { id item_id body text_body creator_id creator { id } created_at } }';
const CHANGE_VALUES =
  'mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) { change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id } }';
const CREATE_UPDATE = 'mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }';
// Notifications are async: Monday may not return an id, so only `text` is selected.
const NOTIFY =
  'mutation ($userId: ID!, $targetId: ID!, $text: String!, $targetType: NotificationTargetType!) { create_notification(user_id: $userId, target_id: $targetId, text: $text, target_type: $targetType) { text } }';
const GET_ASSETS = 'query ($ids: [ID!]!) { assets(ids: $ids) { id name file_extension file_size } }';
const GET_ASSET_URL = 'query ($ids: [ID!]!) { assets(ids: $ids) { id name file_extension public_url } }';
const ADD_FILE =
  'mutation ($itemId: ID!, $columnId: String!, $file: File!) { add_file_to_column(item_id: $itemId, column_id: $columnId, file: $file) { id } }';

interface RawFile {
  asset_id?: string | number | null;
  name?: string | null;
}
interface RawColumnValue {
  id: string;
  type: string;
  text: string | null;
  value: unknown;
  files?: RawFile[] | null;
}
interface RawItem {
  id: string;
  name: string;
  created_at: string | null;
  board: { id: string } | null;
  column_values: RawColumnValue[] | null;
}
interface RawUpdate {
  id: string;
  item_id: string | null;
  body: string | null;
  text_body: string | null;
  creator_id: string | null;
  creator: { id: string } | null;
  created_at: string | null;
}
interface RawAsset {
  id: string;
  name: string;
  file_extension: string | null;
  file_size: number | null;
  public_url?: string | null;
}
interface GqlError {
  message?: string;
  extensions?: { code?: string; retry_in_seconds?: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkId(id: string): string {
  if (!/^\d{1,20}$/.test(id)) throw new MondayApiError(`Invalid Monday id ${JSON.stringify(String(id).slice(0, 40))}`);
  return id;
}

function toSeconds(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'request timed out';
  const code = isObj(err) && isObj(err.cause) && typeof err.cause.code === 'string' ? ` (${err.cause.code})` : '';
  return `network error${code}`;
}

// Error details from a GraphQL response, or null if it succeeded. Monday reports
// application errors with HTTP 200 and an `errors` array, and older errors as
// { error_code, error_message }.
function responseError(res: Response, body: unknown): { message: string; code: string | null; retryIn: number | null } | null {
  const b = isObj(body) ? body : {};
  const errors = (Array.isArray(b.errors) ? b.errors : []) as GqlError[];
  if (res.ok && errors.length === 0 && b.error_message == null && isObj(b.data)) return null;
  const first = errors[0];
  const code = first?.extensions?.code ?? (typeof b.error_code === 'string' ? b.error_code : null);
  const message =
    errors
      .map((e) => e.message)
      .filter(Boolean)
      .join('; ') ||
    (typeof b.error_message === 'string' ? b.error_message : '') ||
    (res.ok ? 'unexpected response' : res.statusText || 'request failed');
  const retryIn = toSeconds(first?.extensions?.retry_in_seconds) ?? toSeconds(res.headers.get('retry-after'));
  return { message: message.slice(0, 300), code, retryIn };
}

function normaliseExt(ext: string | null | undefined): string | null {
  const e = ext?.trim().replace(/^\./, '').toLowerCase();
  return e ? e : null;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  txt: 'text/plain',
  csv: 'text/csv',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  eml: 'message/rfc822',
};

function mimeTypeFor(contentType: string | null, name: string, ext: string | null): string {
  const ct = contentType?.split(';')[0]?.trim().toLowerCase();
  if (ct && /^[\w.+-]+\/[\w.+-]+$/.test(ct) && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  const e = normaliseExt(ext) ?? normaliseExt(extname(name));
  return (e && MIME_BY_EXT[e]) || 'application/octet-stream';
}

// Fallback when the FileValue fragment is absent: the stored JSON lists
// { files: [{ fileType: 'ASSET', assetId, name }] }; links and docs have no assetId.
function filesFromValue(value: string | null): RawFile[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    const files = isObj(parsed) && Array.isArray(parsed.files) ? parsed.files : [];
    return files.filter(isObj).map((f) => ({
      asset_id: typeof f.assetId === 'number' || typeof f.assetId === 'string' ? f.assetId : null,
      name: typeof f.name === 'string' ? f.name : null,
    }));
  } catch {
    return [];
  }
}

function toColumnValue(cv: RawColumnValue): MondayColumnValue {
  const value = cv.value == null ? null : typeof cv.value === 'string' ? cv.value : JSON.stringify(cv.value);
  const col: MondayColumnValue = { id: cv.id, type: cv.type, text: cv.text ?? null, value };
  if (cv.type === 'file') {
    const assets = (cv.files ?? filesFromValue(value)).filter((f) => f.asset_id != null && String(f.asset_id) !== '');
    col.assetIds = assets.map((f) => String(f.asset_id));
    // Monday renders a file column's text as file URLs; keep names instead so no
    // file URL leaves the adapter.
    const names = assets.map((f) => f.name).filter((n): n is string => !!n);
    col.text = names.length ? names.join(', ') : null;
  }
  return col;
}

// The real Monday.com GraphQL API (https://api.monday.com/v2), pinned to
// MONDAY_API_VERSION. Throws MondayApiError on HTTP or GraphQL errors; the job
// queue retries failed jobs.
export class MondayClient implements MondayApi {
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly config: AppConfig,
    opts: MondayClientOptions = {},
  ) {
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
  }

  private authHeaders(): Record<string, string> {
    // Personal and OAuth tokens are sent as-is (no "Bearer").
    return { Authorization: this.config.MONDAY_API_TOKEN, 'API-Version': this.config.MONDAY_API_VERSION };
  }

  // Runs one GraphQL operation. Mutations carry an Idempotency-Key (honoured by
  // Monday for 30 minutes), so retrying one after a timeout can't apply it twice.
  // A caller's key (opts) also covers retries of the whole job; otherwise a fresh
  // one covers this call's own retries.
  async query<T>(query: string, variables: Record<string, unknown> = {}, op = 'request', opts: MondayWriteOptions = {}): Promise<T> {
    const headers: Record<string, string> = { ...this.authHeaders(), 'Content-Type': 'application/json' };
    if (/^\s*mutation\b/.test(query)) headers['Idempotency-Key'] = opts.idempotencyKey ?? randomUUID();
    const body = JSON.stringify({ query, variables });
    return this.send<T>(op, () => fetch(API_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) }), true);
  }

  // `retrySafe`: whether a timeout or 5xx may be retried (the request may have
  // been applied). 429s were not executed and are always retried.
  private async send<T>(op: string, request: () => Promise<Response>, retrySafe: boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.retries;
      let res: Response;
      let text: string;
      try {
        res = await request();
        text = await res.text();
      } catch (err) {
        if (retrySafe && canRetry) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        const note = retrySafe ? '' : ' (it may still have been applied)';
        throw new MondayApiError(`Monday ${op} failed: ${describeFetchError(err)}${note}`);
      }

      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Non-JSON (e.g. a proxy error page); reported below by status.
      }
      const problem = responseError(res, body);
      if (!problem) return (body as { data: T }).data;

      const { message, code, retryIn } = problem;
      const daily = code === 'DAILY_LIMIT_EXCEEDED';
      const rateLimited =
        !daily && (res.status === 429 || (code !== null && RATE_LIMIT_CODES.has(code)) || /rate limit|complexity budget/i.test(message));
      const conflict = res.status === 409 || code === 'IDEMPOTENCY_CONFLICT';
      const serverError = res.status >= 500 || code === 'INTERNAL_SERVER_ERROR';

      if (canRetry && (rateLimited || conflict)) {
        const waitS = retryIn ?? 2 ** attempt;
        if (waitS <= MAX_INLINE_WAIT_S) {
          await this.sleep(waitS * 1000);
          continue;
        }
      }
      if (canRetry && serverError && retrySafe) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }

      let hint = '';
      if (daily) hint = ' (daily API call limit reached; it resets at 00:00 UTC)';
      else if (rateLimited || conflict) {
        const when = retryIn !== null ? `retry in ${retryIn}s` : 'retry later';
        hint = rateLimited ? ` (rate limited; ${when})` : ` (same request still in progress; ${when})`;
      }
      else if (serverError && !retrySafe) hint = ' (it may still have been applied)';
      throw new MondayApiError(`Monday ${op} failed: HTTP ${res.status}${code ? ` ${code}` : ''}: ${message}${hint}`, res.status, code, retryIn);
    }
  }

  async getItem(itemId: string, columnIds?: string[]): Promise<MondayItem | null> {
    const ids = [checkId(itemId)];
    const data = columnIds
      ? await this.query<{ items: RawItem[] | null }>(GET_ITEM_COLUMNS, { ids, columnIds }, 'getItem')
      : await this.query<{ items: RawItem[] | null }>(GET_ITEM, { ids }, 'getItem');
    const raw = data.items?.find((i) => String(i.id) === itemId);
    if (!raw) return null;
    const columnValues: Record<string, MondayColumnValue> = {};
    for (const cv of raw.column_values ?? []) columnValues[cv.id] = toColumnValue(cv);
    return {
      id: String(raw.id),
      boardId: raw.board ? String(raw.board.id) : '',
      name: raw.name,
      createdAt: raw.created_at ?? '',
      columnValues,
    };
  }

  async getUpdate(updateId: string): Promise<MondayUpdate | null> {
    const data = await this.query<{ updates: RawUpdate[] | null }>(GET_UPDATE, { ids: [checkId(updateId)] }, 'getUpdate');
    const u = data.updates?.find((x) => String(x.id) === updateId);
    if (!u) return null;
    return {
      id: String(u.id),
      itemId: u.item_id ? String(u.item_id) : '',
      textBody: u.text_body || (u.body ? htmlToText(u.body) : ''),
      creatorId: u.creator_id ? String(u.creator_id) : u.creator ? String(u.creator.id) : null,
      createdAt: u.created_at ?? '',
    };
  }

  async changeColumnValues(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void> {
    await this.query(
      CHANGE_VALUES,
      { boardId: checkId(boardId), itemId: checkId(itemId), values: JSON.stringify(values) },
      'changeColumnValues',
    );
  }

  async createUpdate(itemId: string, body: string, opts: MondayWriteOptions = {}): Promise<string> {
    const data = await this.query<{ create_update: { id: string } | null }>(CREATE_UPDATE, { itemId: checkId(itemId), body }, 'createUpdate', opts);
    if (!data.create_update?.id) throw new MondayApiError('Monday createUpdate returned no update id');
    return String(data.create_update.id);
  }

  async notifyUser(userId: string, itemId: string, text: string, opts: MondayWriteOptions = {}): Promise<void> {
    await this.query(
      NOTIFY,
      { userId: checkId(userId), targetId: checkId(itemId), text, targetType: 'Project' },
      'notifyUser',
      opts,
    );
  }

  async getAssets(assetIds: string[]): Promise<MondayAsset[]> {
    if (assetIds.length === 0) return [];
    const data = await this.query<{ assets: RawAsset[] | null }>(GET_ASSETS, { ids: assetIds.map(checkId) }, 'getAssets');
    return (data.assets ?? []).map((a) => ({
      id: String(a.id),
      name: a.name,
      fileExtension: normaliseExt(a.file_extension),
      fileSize: typeof a.file_size === 'number' ? a.file_size : a.file_size == null ? null : Number(a.file_size),
    }));
  }

  async downloadAsset(assetId: string): Promise<{ data: Buffer; mimeType: string; name: string }> {
    const data = await this.query<{ assets: RawAsset[] | null }>(GET_ASSET_URL, { ids: [checkId(assetId)] }, 'downloadAsset');
    const asset = data.assets?.find((a) => String(a.id) === assetId);
    if (!asset?.public_url) throw new MondayApiError(`Monday asset ${assetId} not found or has no download URL`);
    // public_url is a bearer link (valid for an hour): fetched here only, never
    // logged, stored or put in an error message. No Authorization header: it
    // points at storage outside monday.com.
    try {
      const res = await fetch(asset.public_url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
      if (!res.ok) throw new MondayApiError(`Monday asset ${assetId} download failed: HTTP ${res.status}`, res.status);
      const bytes = Buffer.from(await res.arrayBuffer());
      return { data: bytes, mimeType: mimeTypeFor(res.headers.get('content-type'), asset.name, asset.file_extension), name: asset.name };
    } catch (err) {
      if (err instanceof MondayApiError) throw err;
      throw new MondayApiError(`Monday asset ${assetId} download failed: ${describeFetchError(err)}`);
    }
  }

  async uploadFileToColumn(itemId: string, columnId: string, file: { name: string; mimeType: string; data: Buffer }): Promise<string> {
    const variables = JSON.stringify({ itemId: checkId(itemId), columnId });
    const name = file.name.replace(/[\x00-\x1f\x7f]/g, '').trim() || 'upload';
    // Multipart per the GraphQL upload convention: `map` points the "file" part
    // at variables.file. Content-Type (with boundary) is set by fetch. No
    // Idempotency-Key: it isn't documented for /v2/file, so 5xx/timeouts aren't retried here.
    const data = await this.send<{ add_file_to_column: { id: string } | null }>(
      'uploadFileToColumn',
      () => {
        const form = new FormData();
        form.append('query', ADD_FILE);
        form.append('variables', variables);
        form.append('map', JSON.stringify({ file: 'variables.file' }));
        form.append('file', new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mimeType }), name);
        return fetch(FILE_URL, { method: 'POST', headers: this.authHeaders(), body: form, signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
      },
      false,
    );
    if (!data.add_file_to_column?.id) throw new MondayApiError('Monday uploadFileToColumn returned no asset id');
    return String(data.add_file_to_column.id);
  }
}
