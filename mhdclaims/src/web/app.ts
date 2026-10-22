import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppContext } from '../services/contracts.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAdminRoutes } from './routes/admin.js';
import { clientKey } from './admin-auth.js';

const here = dirname(fileURLToPath(import.meta.url));
// Static assets are read from src/ in dev and from dist/src/ after build; the
// build step copies them (see package.json "build").
export const STATIC_DIR = join(here, 'static');

// URLs carry the claim's private token (/c/<token>) and the webhook secret
// (/webhooks/<source>/<secret>): never log them, nor any query string.
export function redactUrl(url: string): string {
  return (url.split('?')[0] ?? '')
    .replace(/^\/c\/[^/]+/, '/c/[redacted]')
    .replace(/^\/webhooks\/([^/]+)\/[^/]+/, '/webhooks/$1/[redacted]');
}

// Fastify's own per-request lines print the raw URL; ours (onResponse below) are
// redacted. Error lines stay, and serialise `req` through redactUrl.
class RedactingLogController extends LogController {
  override incomingRequest(): void {}
  override routeNotFound(): void {}
  override requestCompleted(error: Error | null | undefined, req: FastifyRequest, reply: FastifyReply): void {
    if (error) super.requestCompleted(error, req, reply);
  }
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      ctx.config.NODE_ENV === 'test'
        ? false
        : { level: ctx.config.LOG_LEVEL, serializers: { req: (req: { method?: string; url?: string }) => ({ method: req.method, url: redactUrl(req.url ?? '') }) } },
    logController: new RedactingLogController(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode < 400 && (req.url === '/healthz' || req.url.startsWith('/static/'))) return;
    req.log.info(
      { method: req.method, url: redactUrl(req.url), statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request completed',
    );
  });

  await app.register(cookie, { secret: ctx.config.APP_SECRET });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: ctx.config.MAX_UPLOAD_BYTES, files: 10 } });
  // Per client address; an IPv6 client usually holds a whole /64, so per /64.
  await app.register(rateLimit, { global: false, keyGenerator: (req) => clientKey(req.ip) });
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: '/static/', maxAge: '1d' });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (ctx.config.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  app.get('/healthz', async () => ({ ok: true }));

  await registerPublicRoutes(app, ctx);
  await registerPortalRoutes(app, ctx);
  await registerWebhookRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);
  return app;
}
