import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB } from '../src/services/contracts.js';
import { buildApp } from '../src/web/app.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function setup(opts: Parameters<typeof makeTestEnv>[0] = {}) {
  const env = makeTestEnv(opts);
  const app = await buildApp(env.ctx);
  apps.push(app);
  return { env, app };
}

const MONDAY = `/webhooks/monday/webhook-secret-123456`;
const HIGHLEVEL = `/webhooks/highlevel/webhook-secret-123456`;

interface JobRecord {
  type: string;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
}
const jobsOf = (env: TestEnv): JobRecord[] =>
  (env.ctx.db.prepare('SELECT type, payload, dedupe_key FROM jobs ORDER BY id').all() as Array<{ type: string; payload: string; dedupe_key: string | null }>).map(
    (j) => ({ ...j, payload: JSON.parse(j.payload) as Record<string, unknown> }),
  );

const post = (app: FastifyInstance, url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

// Monday delivers ids as numbers and event types that differ from the subscription name.
const mondayEvent = (env: TestEnv, event: Record<string, unknown>) => ({
  event: { boardId: Number(env.board.claimsBoardId), pulseId: 5550001, userId: 111, triggerUuid: 'trig-1', ...event },
});

const statusValue = (text: string) => ({ label: { index: 1, text, style: { color: '#00c875' }, is_done: false }, post_id: null });

describe('Monday webhook', () => {
  it('answers 404 for a wrong secret and enqueues nothing', async () => {
    const { env, app } = await setup();
    const res = await post(app, '/webhooks/monday/not-the-secret', mondayEvent(env, { type: 'create_pulse' }));
    expect(res.statusCode).toBe(404);
    expect((await post(app, '/webhooks/monday/', { challenge: 'x' })).statusCode).toBe(404);
    expect(jobsOf(env)).toEqual([]);
  });

  it('echoes the challenge', async () => {
    const { app } = await setup();
    const res = await post(app, MONDAY, { challenge: 'abc-123' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: 'abc-123' });
  });

  it('rejects invalid JSON', async () => {
    const { env, app } = await setup();
    expect((await post(app, MONDAY, '{not json')).statusCode).toBe(400);
    expect(jobsOf(env)).toEqual([]);
  });

  it('queues a new claims-board item once, however often it is delivered', async () => {
    const { env, app } = await setup();
    const body = mondayEvent(env, { type: 'create_pulse', pulseName: 'Jane Doe', columnValues: {} });
    const first = await post(app, MONDAY, body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, result: 'queued' });
    const again = await post(app, MONDAY, body);
    expect(again.json()).toMatchObject({ result: 'duplicate' });
    // A different delivery for the same item is deduped by the job key.
    const other = await post(app, MONDAY, mondayEvent(env, { type: 'create_pulse', triggerUuid: 'trig-2' }));
    expect(other.json()).toMatchObject({ result: 'duplicate' });

    expect(jobsOf(env)).toEqual([{ type: JOB.mondayItemCreated, payload: { itemId: '5550001' }, dedupe_key: 'item:5550001' }]);
    expect(env.ctx.repo.markEventProcessed('monday:trig-1')).toBe(false);
  });

  it('queues status changes on the status column with the trigger id as event id', async () => {
    const { env, app } = await setup();
    const res = await post(
      app,
      MONDAY,
      mondayEvent(env, { type: 'update_column_value', columnId: env.board.columns.status, columnType: 'color', value: statusValue('Under review') }),
    );
    expect(res.statusCode).toBe(200);
    expect(jobsOf(env)).toEqual([
      { type: JOB.mondayStatusChanged, payload: { itemId: '5550001', label: 'Under review', eventId: 'trig-1' }, dedupe_key: 'status:trig-1' },
    ]);
  });

  it('falls back to a hash of the body as the event id when there is no trigger id', async () => {
    const { env, app } = await setup();
    const raw = JSON.stringify(
      mondayEvent(env, {
        type: 'update_column_value',
        triggerUuid: undefined,
        columnId: env.board.columns.status,
        columnType: 'color',
        value: statusValue('Closed'),
        changedAt: 1729580000.5,
      }),
    );
    await post(app, MONDAY, raw);
    await post(app, MONDAY, raw); // the same delivery again
    const hash = createHash('sha256').update(raw).digest('hex');
    expect(jobsOf(env)).toEqual([
      { type: JOB.mondayStatusChanged, payload: { itemId: '5550001', label: 'Closed', eventId: hash }, dedupe_key: `status:${hash}` },
    ]);
  });

  it('ignores status changes on other status columns', async () => {
    const { env, app } = await setup();
    const res = await post(app, MONDAY, mondayEvent(env, { type: 'update_column_value', columnId: 'status_internal', columnType: 'color', value: statusValue('Done') }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ignored: expect.any(String) });
    expect(jobsOf(env)).toEqual([]);
  });

  it('queues changes to claimant-visible file columns only', async () => {
    const { env, app } = await setup();
    const visible = [env.board.sharedFileColumns[0]!, env.board.columns.signedSettlement, env.board.columns.intakePhotos!, env.board.columns.claimantUploads];
    for (const [i, columnId] of visible.entries()) {
      const res = await post(app, MONDAY, mondayEvent(env, { type: 'update_column_value', triggerUuid: `f-${i}`, columnId, columnType: 'file', value: { files: [] } }));
      expect(res.json()).toMatchObject({ result: 'queued' });
    }
    // An internal file column and an ordinary text column are never read.
    for (const columnId of ['file_internal_invoices', env.board.columns.email]) {
      const res = await post(app, MONDAY, mondayEvent(env, { type: 'update_column_value', triggerUuid: `x-${columnId}`, columnId, columnType: 'file', value: { files: [] } }));
      expect(res.json()).toMatchObject({ ignored: expect.any(String) });
    }
    expect(jobsOf(env).map((j) => [j.type, j.payload.columnId])).toEqual(visible.map((c) => [JOB.mondayColumnChanged, c]));
  });

  it('queues new updates with the parsed event, deduped by update id', async () => {
    const { env, app } = await setup();
    const body = mondayEvent(env, { type: 'create_update', updateId: 8880001, body: '<p>To claimant: hello</p>', textBody: 'To claimant: hello' });
    await post(app, MONDAY, body);
    await post(app, MONDAY, { event: { ...body.event, triggerUuid: 'trig-other' } });
    expect(jobsOf(env)).toEqual([
      {
        type: JOB.mondayUpdateCreated,
        payload: {
          kind: 'update_created',
          boardId: env.board.claimsBoardId,
          itemId: '5550001',
          updateId: '8880001',
          textBody: 'To claimant: hello',
          creatorId: '111',
          triggerUuid: 'trig-1',
        },
        dedupe_key: 'update:8880001',
      },
    ]);
  });

  it('routes new payment-board items to the payment job and ignores other boards', async () => {
    const { env, app } = await setup();
    const paymentBoard = Number(env.board.paymentBoard!.boardId);
    await post(app, MONDAY, { event: { type: 'create_pulse', boardId: paymentBoard, pulseId: 6660001, triggerUuid: 'p-1' } });
    // Column changes on the payment board (bank details) are never queued.
    await post(app, MONDAY, { event: { type: 'update_column_value', boardId: paymentBoard, pulseId: 6660001, triggerUuid: 'p-2', columnId: 'text_bank', value: { value: 'x' } } });
    await post(app, MONDAY, { event: { type: 'create_pulse', boardId: 999000111, pulseId: 7770001, triggerUuid: 'o-1' } });
    expect(jobsOf(env)).toEqual([{ type: JOB.paymentItemCreated, payload: { itemId: '6660001' }, dedupe_key: 'payment:6660001' }]);
  });

  it('ignores payment-board items when no payment board is configured', async () => {
    const { env, app } = await setup({ board: { paymentBoard: undefined } });
    const res = await post(app, MONDAY, { event: { type: 'create_pulse', boardId: 2234567890, pulseId: 6660001, triggerUuid: 'p-1' } });
    expect(res.statusCode).toBe(200);
    expect(jobsOf(env)).toEqual([]);
  });

  it('answers 500 when the job cannot be stored, and accepts the retry', async () => {
    const { env, app } = await setup();
    const spy = vi.spyOn(env.ctx.jobs, 'enqueue').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const body = mondayEvent(env, { type: 'create_pulse' });
    expect((await post(app, MONDAY, body)).statusCode).toBe(500);
    // The delivery was not marked as processed, so Monday's retry is queued.
    const retry = await post(app, MONDAY, body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ result: 'queued' });
    expect(jobsOf(env)).toHaveLength(1);
    spy.mockRestore();
  });

  it('requires a valid Authorization JWT when a signing secret is set, but not for the challenge', async () => {
    const secret = 'monday-signing-secret';
    const { env, app } = await setup({ config: { MONDAY_SIGNING_SECRET: secret } });
    const jwt = (key: string) => {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ accountId: 1, exp: Math.floor(Date.now() / 1000) + 60 })}`;
      return `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`;
    };
    expect((await post(app, MONDAY, { challenge: 'c' })).json()).toEqual({ challenge: 'c' });

    const body = mondayEvent(env, { type: 'create_pulse' });
    expect((await post(app, MONDAY, body)).statusCode).toBe(401);
    expect((await post(app, MONDAY, body, { authorization: jwt('wrong-secret') })).statusCode).toBe(401);
    expect(jobsOf(env)).toEqual([]);
    const ok = await post(app, MONDAY, body, { authorization: jwt(secret) });
    expect(ok.statusCode).toBe(200);
    expect(jobsOf(env)).toHaveLength(1);
  });

  it('rejects bodies over 1 MB', async () => {
    const { env, app } = await setup();
    const res = await post(app, MONDAY, { challenge: 'x'.repeat(1024 * 1024 + 10) });
    expect(res.statusCode).toBe(413);
    expect(jobsOf(env)).toEqual([]);
  });
});

describe('HighLevel webhook', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signed = (raw: string) => sign(null, Buffer.from(raw), privateKey).toString('base64');
  const setupSigned = () => setup({ config: { HIGHLEVEL_WEBHOOK_PUBLIC_KEY: publicPem } });

  const inbound = {
    type: 'InboundMessage',
    locationId: 'loc_test',
    attachments: [],
    body: 'When will I hear back?',
    contactId: 'cI08i1Bls3iTB9bKgFJh',
    contentType: 'text/plain',
    conversationId: 'conv1',
    dateAdded: '2026-10-22T11:31:45.750Z',
    direction: 'inbound',
    messageType: 'SMS',
    messageId: 'msgAbc123',
    status: 'delivered',
  };

  it('answers 404 for a wrong secret', async () => {
    const { env, app } = await setup();
    expect((await post(app, '/webhooks/highlevel/nope', inbound)).statusCode).toBe(404);
    expect(jobsOf(env)).toEqual([]);
  });

  it('accepts a signed marketplace InboundMessage and verifies the exact raw body', async () => {
    const { env, app } = await setupSigned();
    // Odd spacing on purpose: the signature covers these exact bytes.
    const raw = JSON.stringify(inbound, null, 3);
    const res = await post(app, HIGHLEVEL, raw, { 'x-ghl-signature': signed(raw) });
    expect(res.statusCode).toBe(200);
    expect(jobsOf(env)).toEqual([
      {
        type: JOB.highlevelInbound,
        payload: { kind: 'inbound_message', contactId: inbound.contactId, channel: 'sms', body: inbound.body, messageId: 'msgAbc123', subject: null },
        dedupe_key: 'hl-message:msgAbc123',
      },
    ]);
    // A retry of the same message is not queued twice.
    const again = await post(app, HIGHLEVEL, raw, { 'x-ghl-signature': signed(raw) });
    expect(again.json()).toMatchObject({ result: 'duplicate' });
    expect(jobsOf(env)).toHaveLength(1);
  });

  it('rejects a signature that does not match the body', async () => {
    const { env, app } = await setupSigned();
    const raw = JSON.stringify(inbound);
    const tampered = raw.replace('When will I hear back?', 'Send the money elsewhere');
    expect((await post(app, HIGHLEVEL, tampered, { 'x-ghl-signature': signed(raw) })).statusCode).toBe(401);
    expect((await post(app, HIGHLEVEL, raw, { 'x-ghl-signature': 'not-a-signature' })).statusCode).toBe(401);
    expect((await post(app, HIGHLEVEL, raw, { 'x-ghl-signature': '' })).statusCode).toBe(401);
    expect(jobsOf(env)).toEqual([]);
  });

  it('accepts unsigned workflow webhooks on the secret path', async () => {
    const { env, app } = await setupSigned();
    const workflow = (customData: Record<string, string>) => ({
      contact_id: 'cI08i1Bls3iTB9bKgFJh',
      first_name: 'Jane',
      email: 'jane@example.com',
      location: { id: 'loc_test' },
      customData,
    });
    await post(app, HIGHLEVEL, workflow({ hdc_event: 'inbound_message', contact_id: 'cI08i1Bls3iTB9bKgFJh', claim_number: 'HDC-000001', message_body: 'STATUS', message_type: 'SMS', message_id: '{{message.id}}' }));
    await post(app, HIGHLEVEL, workflow({ hdc_event: 'document_signed', contact_id: 'cI08i1Bls3iTB9bKgFJh', claim_number: 'hdc-000001' }));
    await post(app, HIGHLEVEL, workflow({ hdc_event: 'document_signed', contact_id: 'cI08i1Bls3iTB9bKgFJh', claim_number: 'HDC-000001' }));
    await post(app, HIGHLEVEL, workflow({ hdc_event: 'document_declined', contact_id: 'cI08i1Bls3iTB9bKgFJh', claim_number: 'HDC-000001' }));
    const res = await post(app, HIGHLEVEL, workflow({ hdc_event: 'something_else' }));
    expect(res.json()).toMatchObject({ ignored: expect.any(String) });

    expect(jobsOf(env)).toEqual([
      {
        type: JOB.highlevelInbound,
        payload: { kind: 'inbound_message', contactId: 'cI08i1Bls3iTB9bKgFJh', channel: 'sms', body: 'STATUS', messageId: null, subject: null },
        dedupe_key: null,
      },
      // Signed-document calls are always queued; the settlement service is idempotent.
      { type: JOB.highlevelDocumentSigned, payload: { kind: 'document_signed', contactId: 'cI08i1Bls3iTB9bKgFJh', documentId: null, claimNumber: 'HDC-000001' }, dedupe_key: null },
      { type: JOB.highlevelDocumentSigned, payload: { kind: 'document_signed', contactId: 'cI08i1Bls3iTB9bKgFJh', documentId: null, claimNumber: 'HDC-000001' }, dedupe_key: null },
      { type: JOB.highlevelDocumentDeclined, payload: { kind: 'document_declined', contactId: 'cI08i1Bls3iTB9bKgFJh', claimNumber: 'HDC-000001' }, dedupe_key: null },
    ]);
  });

  it('reads the raw body whatever the content type', async () => {
    const { env, app } = await setup();
    const res = await app.inject({ method: 'POST', url: HIGHLEVEL, payload: JSON.stringify(inbound), headers: { 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(200);
    expect(jobsOf(env)).toHaveLength(1);
  });
});

describe('webhook body parsing is scoped', () => {
  it('leaves form parsing on other routes alone', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/find-my-claim',
      payload: 'email=not-an-email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // The public form parsed the body and rejected the address (not a 415).
    expect(res.statusCode).toBe(400);
  });
});
