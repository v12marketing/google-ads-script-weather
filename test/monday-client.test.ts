import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MondayApiError, MondayClient } from '../src/adapters/monday/client.js';
import { testConfig } from '../src/config.js';

const config = testConfig({ MONDAY_API_TOKEN: 'tok_secret', MONDAY_API_VERSION: '2026-10' });

let calls: Array<{ url: string; init: RequestInit }>;
let queue: Array<Response | Error>;
let sleeps: number[];

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

beforeEach(() => {
  calls = [];
  queue = [];
  sleeps = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const next = queue.shift();
      if (!next) throw new Error('unexpected fetch');
      if (next instanceof Error) throw next;
      return next;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (retries = 2) =>
  new MondayClient(config, {
    retries,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
const sent = (i = 0) => JSON.parse(calls[i]!.init.body as string) as { query: string; variables: Record<string, unknown> };
const headers = (i = 0) => new Headers(calls[i]!.init.headers);

describe('MondayClient requests', () => {
  it('getItem sends a pinned, authorised GraphQL query with variables and parses columns', async () => {
    queue.push(
      json({
        data: {
          items: [
            {
              id: '123',
              name: 'Jane Doe',
              created_at: '2026-10-01T10:00:00Z',
              board: { id: '42' },
              column_values: [
                { id: 'email', type: 'email', text: 'jane@example.com', value: '{"email":"jane@example.com","text":"jane@example.com"}' },
                {
                  id: 'files_a',
                  type: 'file',
                  text: 'https://example.monday.com/protected_static/1/a.pdf',
                  value: '{"files":[{"assetId":555,"name":"a.pdf"}]}',
                  files: [{ asset_id: '555', name: 'a.pdf' }, {}],
                },
                // No FileValue fragment data: fall back to the stored JSON.
                { id: 'files_b', type: 'file', text: '', value: '{"files":[{"fileType":"ASSET","assetId":777,"name":"b.jpg"},{"fileType":"LINK","name":"x"}]}' },
                { id: 'status', type: 'status', text: 'New', value: null },
              ],
            },
          ],
        },
      }),
    );
    const item = await client().getItem('123', ['email', 'files_a', 'files_b', 'status']);

    expect(calls[0]!.url).toBe('https://api.monday.com/v2');
    expect(calls[0]!.init.method).toBe('POST');
    const h = headers();
    expect(h.get('authorization')).toBe('tok_secret');
    expect(h.get('api-version')).toBe('2026-10');
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('idempotency-key')).toBeNull(); // queries don't carry one
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const { query, variables } = sent();
    expect(query).toContain('items(ids: $ids, limit: 1)');
    expect(query).toContain('column_values(ids: $columnIds)');
    expect(query).toContain('... on FileValue');
    expect(query).not.toContain('123');
    expect(variables).toEqual({ ids: ['123'], columnIds: ['email', 'files_a', 'files_b', 'status'] });

    expect(item).toEqual({
      id: '123',
      boardId: '42',
      name: 'Jane Doe',
      createdAt: '2026-10-01T10:00:00Z',
      columnValues: {
        email: { id: 'email', type: 'email', text: 'jane@example.com', value: '{"email":"jane@example.com","text":"jane@example.com"}' },
        files_a: { id: 'files_a', type: 'file', text: 'a.pdf', value: '{"files":[{"assetId":555,"name":"a.pdf"}]}', assetIds: ['555'] },
        files_b: {
          id: 'files_b',
          type: 'file',
          text: 'b.jpg',
          value: '{"files":[{"fileType":"ASSET","assetId":777,"name":"b.jpg"},{"fileType":"LINK","name":"x"}]}',
          assetIds: ['777'],
        },
        status: { id: 'status', type: 'status', text: 'New', value: null },
      },
    });
  });

  it('getItem without column ids asks for every column; a missing item is null', async () => {
    queue.push(json({ data: { items: [] } }));
    expect(await client().getItem('9')).toBeNull();
    expect(sent().query).toContain('column_values {');
    expect(sent().variables).toEqual({ ids: ['9'] });
  });

  it('rejects non-numeric ids before calling the API', async () => {
    await expect(client().getItem('1 OR 1')).rejects.toBeInstanceOf(MondayApiError);
    expect(calls).toHaveLength(0);
  });

  it('getUpdate parses the update and falls back to the HTML body', async () => {
    queue.push(
      json({
        data: {
          updates: [
            { id: '77', item_id: '123', body: '<p>To claimant: hello &amp; welcome</p>', text_body: '', creator_id: null, creator: { id: '111' }, created_at: '2026-10-02T00:00:00Z' },
          ],
        },
      }),
    );
    const u = await client().getUpdate('77');
    expect(sent().query).toContain('updates(ids: $ids');
    expect(sent().variables).toEqual({ ids: ['77'] });
    expect(u).toEqual({ id: '77', itemId: '123', textBody: 'To claimant: hello & welcome', creatorId: '111', createdAt: '2026-10-02T00:00:00Z' });

    queue.push(json({ data: { updates: [] } }));
    expect(await client().getUpdate('78')).toBeNull();
  });

  it('changeColumnValues sends column_values as a JSON string with an Idempotency-Key', async () => {
    queue.push(json({ data: { change_multiple_column_values: { id: '123' } } }));
    await client().changeColumnValues('42', '123', { text_x: 'HDC-000001', status: { label: 'Settlement signed' } });
    const { query, variables } = sent();
    expect(query).toMatch(/^mutation/);
    expect(query).toContain('change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values)');
    expect(variables).toEqual({ boardId: '42', itemId: '123', values: '{"text_x":"HDC-000001","status":{"label":"Settlement signed"}}' });
    expect(headers().get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createUpdate returns the new update id', async () => {
    queue.push(json({ data: { create_update: { id: 9001 } } }));
    expect(await client().createUpdate('123', '<p>Hi</p>')).toBe('9001');
    expect(sent().variables).toEqual({ itemId: '123', body: '<p>Hi</p>' });
  });

  it('notifyUser targets the item as a Project via an enum variable', async () => {
    queue.push(json({ data: { create_notification: { text: 'x' } } }));
    await client().notifyUser('111', '123', 'New message on HDC-000001');
    const { query, variables } = sent();
    expect(query).toContain('$targetType: NotificationTargetType!');
    expect(variables).toEqual({ userId: '111', targetId: '123', text: 'New message on HDC-000001', targetType: 'Project' });
  });

  it('getAssets maps metadata without asking for public urls', async () => {
    queue.push(json({ data: { assets: [{ id: '555', name: 'a.pdf', file_extension: '.PDF', file_size: 2048 }] } }));
    expect(await client().getAssets(['555'])).toEqual([{ id: '555', name: 'a.pdf', fileExtension: 'pdf', fileSize: 2048 }]);
    expect(sent().query).not.toContain('public_url');
    expect(await client().getAssets([])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('downloadAsset resolves public_url and fetches it without the API token', async () => {
    queue.push(json({ data: { assets: [{ id: '555', name: 'photo.heic', file_extension: '.heic', public_url: 'https://files.example/s3/abc?sig=1' }] } }));
    queue.push(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'binary/octet-stream' } }));
    const out = await client().downloadAsset('555');
    expect(sent().query).toContain('public_url');
    expect(calls[1]!.url).toBe('https://files.example/s3/abc?sig=1');
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBeNull();
    expect(out).toEqual({ data: Buffer.from([1, 2, 3]), mimeType: 'image/heic', name: 'photo.heic' });

    queue.push(json({ data: { assets: [{ id: '556', name: 'a.pdf', file_extension: '.pdf', public_url: 'https://files.example/s3/def?sig=2' }] } }));
    queue.push(new Response('x', { status: 200, headers: { 'content-type': 'application/pdf; charset=binary' } }));
    expect((await client().downloadAsset('556')).mimeType).toBe('application/pdf');
  });

  it('download failures never reveal the public url', async () => {
    queue.push(json({ data: { assets: [{ id: '555', name: 'a.pdf', file_extension: '.pdf', public_url: 'https://files.example/s3/abc?sig=SECRET' }] } }));
    queue.push(new Response('denied', { status: 403 }));
    const err = await client().downloadAsset('555').catch((e: Error) => e);
    expect(err).toBeInstanceOf(MondayApiError);
    expect((err as Error).message).toContain('HTTP 403');
    expect((err as Error).message).not.toContain('SECRET');

    queue.push(json({ data: { assets: [{ id: '555', name: 'a.pdf', file_extension: '.pdf', public_url: 'https://files.example/s3/abc?sig=SECRET' }] } }));
    queue.push(Object.assign(new TypeError('fetch failed https://files.example/s3/abc?sig=SECRET'), { cause: { code: 'ECONNRESET' } }));
    const err2 = await client().downloadAsset('555').catch((e: Error) => e);
    expect((err2 as Error).message).toBe('Monday asset 555 download failed: network error (ECONNRESET)');

    queue.push(json({ data: { assets: [] } }));
    await expect(client().downloadAsset('999')).rejects.toThrow('not found');
  });

  it('uploadFileToColumn posts multipart to /v2/file with query, variables, map and file parts', async () => {
    queue.push(json({ data: { add_file_to_column: { id: '888' } } }));
    const id = await client().uploadFileToColumn('123', 'file_claimant_uploads', {
      name: 'damage.jpg',
      mimeType: 'image/jpeg',
      data: Buffer.from('jpegdata'),
    });
    expect(id).toBe('888');
    expect(calls[0]!.url).toBe('https://api.monday.com/v2/file');
    const h = headers();
    expect(h.get('authorization')).toBe('tok_secret');
    expect(h.get('api-version')).toBe('2026-10');
    expect(h.get('content-type')).toBeNull(); // fetch sets the multipart boundary
    expect(h.get('idempotency-key')).toBeNull();
    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('query')).toContain('add_file_to_column(item_id: $itemId, column_id: $columnId, file: $file)');
    expect(JSON.parse(form.get('variables') as string)).toEqual({ itemId: '123', columnId: 'file_claimant_uploads' });
    expect(JSON.parse(form.get('map') as string)).toEqual({ file: 'variables.file' });
    const file = form.get('file') as File;
    expect(file.name).toBe('damage.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('jpegdata');
  });
});

describe('MondayClient errors and retries', () => {
  it('throws on a GraphQL errors array returned with HTTP 200', async () => {
    queue.push(json({ data: null, errors: [{ message: 'Column not found', extensions: { code: 'InvalidColumnIdException' } }] }));
    const err = (await client().getItem('1').catch((e: unknown) => e)) as MondayApiError;
    expect(err).toBeInstanceOf(MondayApiError);
    expect(err.message).toBe('Monday getItem failed: HTTP 200 InvalidColumnIdException: Column not found');
    expect(err.code).toBe('InvalidColumnIdException');
    expect(calls).toHaveLength(1);
  });

  it('throws on legacy error_message responses and on HTTP errors without JSON', async () => {
    queue.push(json({ error_code: 'UserUnauthorizedException', error_message: 'User unauthorized', status_code: 403 }, { status: 403 }));
    await expect(client().getItem('1')).rejects.toThrow('HTTP 403 UserUnauthorizedException: User unauthorized');
    queue.push(new Response('<html>bad gateway</html>', { status: 401, statusText: 'Unauthorized' }));
    await expect(client().getItem('1')).rejects.toThrow('Monday getItem failed: HTTP 401: Unauthorized');
  });

  it('waits out short rate limits inside the call', async () => {
    queue.push(json({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 4 } }] }));
    queue.push(json({ data: { items: [] } }));
    expect(await client().getItem('1')).toBeNull();
    expect(sleeps).toEqual([4000]);
    expect(calls).toHaveLength(2);
  });

  it('reports long rate limits with retry info so the job queue retries', async () => {
    queue.push(json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATE_LIMIT_EXCEEDED' } }] }, { status: 429, headers: { 'retry-after': '45' } }));
    const err = (await client().getItem('1').catch((e: unknown) => e)) as MondayApiError;
    expect(err.message).toContain('(rate limited; retry in 45s)');
    expect(err.retryInSeconds).toBe(45);
    expect(err.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it('does not retry the daily limit', async () => {
    queue.push(json({ errors: [{ message: 'Daily limit exceeded', extensions: { code: 'DAILY_LIMIT_EXCEEDED', retry_in_seconds: 3 } }] }, { status: 429 }));
    await expect(client().getItem('1')).rejects.toThrow('resets at 00:00 UTC');
    expect(calls).toHaveLength(1);
  });

  it('retries a mutation after a timeout with the same Idempotency-Key', async () => {
    queue.push(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    queue.push(json({ data: { create_update: { id: '5' } } }));
    expect(await client().createUpdate('123', '<p>x</p>')).toBe('5');
    expect(calls).toHaveLength(2);
    expect(headers(0).get('idempotency-key')).toBe(headers(1).get('idempotency-key'));
    expect(sleeps).toEqual([1000]);
  });

  it('retries queries on 5xx and gives up after the configured attempts', async () => {
    queue.push(new Response('oops', { status: 502 }), new Response('oops', { status: 503 }), new Response('oops', { status: 500 }));
    await expect(client(2).getItem('1')).rejects.toThrow('HTTP 500');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('never retries an upload that may have landed', async () => {
    queue.push(new Response('oops', { status: 500 }));
    await expect(client().uploadFileToColumn('1', 'f', { name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') })).rejects.toThrow(
      'it may still have been applied',
    );
    queue.push(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(client().uploadFileToColumn('1', 'f', { name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') })).rejects.toThrow(
      'request timed out (it may still have been applied)',
    );
    expect(calls).toHaveLength(2);
  });

  it('error messages never include the API token', async () => {
    queue.push(json({ errors: [{ message: 'Not authenticated' }] }, { status: 401 }));
    const err = (await client().getItem('1').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('tok_secret');
  });
});
