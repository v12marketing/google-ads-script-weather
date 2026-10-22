import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { visibleFileColumns } from '../../board-config.js';
import { parseHighLevelWebhook, verifyHighLevelSignature } from '../../adapters/highlevel/webhook.js';
import type { MondayEvent } from '../../adapters/monday/types.js';
import { parseMondayWebhook, verifyMondayAuthorization } from '../../adapters/monday/webhook.js';
import { JOB, type AppContext } from '../../services/contracts.js';
import { safeEqualStrings } from '../admin-auth.js';

// Inbound webhooks. Handlers only check the secret path (and a signature where
// the sender provides one), dedupe and enqueue a job, then answer 200. The 200 is
// sent only once the job is committed to SQLite; any failure answers 500 so the
// sender retries. Request bodies are never logged: they carry claimant messages.

export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

interface Enqueue {
  type: string;
  payload: unknown;
  dedupeKey?: string;
}

type SecretParams = { Params: { secret: string } };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// Thrown inside the enqueue transaction to roll it back when the delivery was already handled.
class AlreadyProcessed extends Error {}

export async function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, board, db, repo, jobs, log } = ctx;
  const fileColumns = new Set(visibleFileColumns(board).map((c) => c.columnId));

  // Encapsulated so the raw-body parser applies to these routes only.
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));

    hooks.addHook('onSend', async (_req, reply, payload) => {
      reply.header('Cache-Control', 'no-store');
      return payload;
    });

    hooks.setErrorHandler((err, req, reply) => {
      const status = (err as { statusCode?: unknown }).statusCode;
      const code = typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
      if (code >= 500) {
        // The route pattern only: the URL carries the webhook secret.
        log.error({ route: req.routeOptions.url, err: (err instanceof Error ? err.message : String(err)).split('\n')[0] }, 'webhook: failed');
      }
      return reply.code(code).send({ statusCode: code, error: code >= 500 ? 'Internal Server Error' : 'Bad Request' });
    });

    const notFound = (reply: FastifyReply) => reply.code(404).send({ statusCode: 404, error: 'Not Found' });
    const rawBody = (req: FastifyRequest): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    const parseJson = (raw: Buffer): unknown => {
      try {
        return JSON.parse(raw.toString('utf8'));
      } catch {
        return undefined;
      }
    };

    // Enqueues the job and then records the delivery id, in one transaction: a
    // redelivery can neither be lost (marked but not queued) nor run twice.
    const enqueue = (job: Enqueue, eventKey: string | null): 'queued' | 'duplicate' => {
      try {
        return db.transaction(() => {
          const added = jobs.enqueue(job.type, job.payload, job.dedupeKey ? { dedupeKey: job.dedupeKey } : {});
          if (eventKey && !repo.markEventProcessed(eventKey)) throw new AlreadyProcessed();
          return added ? ('queued' as const) : ('duplicate' as const);
        })();
      } catch (err) {
        if (err instanceof AlreadyProcessed) return 'duplicate';
        throw err;
      }
    };

    // --- Monday ---

    const mondayJob = (ev: MondayEvent, raw: Buffer): Enqueue | null => {
      if (ev.boardId === board.claimsBoardId) {
        switch (ev.kind) {
          case 'item_created':
            return { type: JOB.mondayItemCreated, payload: { itemId: ev.itemId }, dedupeKey: `item:${ev.itemId}` };
          case 'status_changed': {
            if (ev.columnId !== board.columns.status) return null;
            const eventId = ev.triggerUuid ?? sha256(raw);
            return {
              type: JOB.mondayStatusChanged,
              payload: { itemId: ev.itemId, label: ev.label, eventId },
              dedupeKey: `status:${eventId}`,
            };
          }
          case 'column_changed':
            // Internal file columns (and every non-file column) are never read.
            if (!fileColumns.has(ev.columnId)) return null;
            return {
              type: JOB.mondayColumnChanged,
              payload: { itemId: ev.itemId, columnId: ev.columnId },
              dedupeKey: `column:${ev.triggerUuid ?? sha256(raw)}`,
            };
          case 'update_created':
            return { type: JOB.mondayUpdateCreated, payload: ev, dedupeKey: `update:${ev.updateId}` };
        }
      }
      if (board.paymentBoard && ev.boardId === board.paymentBoard.boardId && ev.kind === 'item_created') {
        return { type: JOB.paymentItemCreated, payload: { itemId: ev.itemId }, dedupeKey: `payment:${ev.itemId}` };
      }
      return null;
    };

    hooks.post<SecretParams>('/webhooks/monday/:secret', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (req, reply) => {
      if (!safeEqualStrings(req.params.secret, config.WEBHOOK_SECRET)) return notFound(reply);
      const raw = rawBody(req);
      const body = parseJson(raw);
      if (body === undefined) return reply.code(400).send({ statusCode: 400, error: 'Invalid JSON' });
      // The handshake is unsigned, so it is answered before the JWT check.
      if (isObj(body) && typeof body.challenge === 'string') return reply.send({ challenge: body.challenge });
      if (!verifyMondayAuthorization(req.headers.authorization, config.MONDAY_SIGNING_SECRET)) {
        log.warn({ source: 'monday' }, 'webhook: authorization check failed');
        return reply.code(401).send({ statusCode: 401, error: 'Unauthorized' });
      }

      const parsed = parseMondayWebhook(body);
      if ('challenge' in parsed) return reply.send({ challenge: parsed.challenge });
      if ('ignore' in parsed) return reply.send({ ok: true, ignored: parsed.ignore });
      const ev = parsed.event;
      const job = mondayJob(ev, raw);
      if (!job) return reply.send({ ok: true, ignored: `${ev.kind} is not handled for this board or column` });

      const result = enqueue(job, ev.triggerUuid ? `monday:${ev.triggerUuid}` : null);
      log.info({ source: 'monday', kind: ev.kind, itemId: ev.itemId, job: job.type, result }, 'webhook: received');
      return reply.send({ ok: true, result });
    });

    // --- HighLevel ---

    hooks.post<SecretParams>('/webhooks/highlevel/:secret', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (req, reply) => {
      if (!safeEqualStrings(req.params.secret, config.WEBHOOK_SECRET)) return notFound(reply);
      const raw = rawBody(req);
      // Marketplace webhooks are signed over the raw bytes. Workflow Webhook actions
      // can't be signed and rely on the secret path alone. A signature that is
      // present must verify.
      const header = req.headers['x-ghl-signature'];
      const signed = header !== undefined;
      if (signed) {
        const sig = Array.isArray(header) ? header[0] : header;
        if (!verifyHighLevelSignature(raw, sig, config.HIGHLEVEL_WEBHOOK_PUBLIC_KEY)) {
          log.warn({ source: 'highlevel' }, 'webhook: signature check failed');
          return reply.code(401).send({ statusCode: 401, error: 'Unauthorized' });
        }
      }
      const body = parseJson(raw);
      if (body === undefined) return reply.code(400).send({ statusCode: 400, error: 'Invalid JSON' });

      const ev = parseHighLevelWebhook(body);
      if (!ev) return reply.send({ ok: true, ignored: 'not an event this service handles' });

      let job: Enqueue;
      switch (ev.kind) {
        case 'inbound_message':
          job = { type: JOB.highlevelInbound, payload: ev, ...(ev.messageId ? { dedupeKey: `hl-message:${ev.messageId}` } : {}) };
          break;
        case 'document_signed':
          // No reliable delivery id to dedupe on; the settlement service is idempotent.
          job = { type: JOB.highlevelDocumentSigned, payload: ev };
          break;
        case 'document_declined':
          job = { type: JOB.highlevelDocumentDeclined, payload: ev };
          break;
      }
      const result = enqueue(job, null);
      log.info({ source: 'highlevel', kind: ev.kind, signed, job: job.type, result }, 'webhook: received');
      return reply.send({ ok: true, result });
    });
  });
}
