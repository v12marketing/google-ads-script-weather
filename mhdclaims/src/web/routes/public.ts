import { STATUS_CODES } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../services/contracts.js';
import { escapeHtml } from '../html.js';
import { page } from '../layout.js';
import type { PublicPage } from '../pages/common.js';
import { badRequestPage, notFoundPage, serverErrorPage, tooManyRequestsPage } from '../pages/errors.js';
import { faqPage } from '../pages/faq.js';
import { findClaimFormPage, findClaimSentPage } from '../pages/find-claim.js';
import { homePage } from '../pages/home.js';
import { howItWorksPage } from '../pages/how-it-works.js';
import { privacyPage } from '../pages/privacy.js';
import { startClaimPage } from '../pages/start-claim.js';
import { termsPage } from '../pages/terms.js';

// Hosts the claim WorkForm is served from. The configured embed URL's own origin
// is added too, in case the form is ever served from elsewhere.
const FORM_FRAME_SRC = ['https://forms.monday.com', 'https://*.monday.com'];

const SITEMAP_PATHS = ['/', '/start-a-claim', '/how-it-works', '/faq', '/find-my-claim', '/privacy', '/terms'];

const FIND_CLAIM_LIMIT = { max: 5, timeWindow: 15 * 60_000 };

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function parseEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// Our pages use no inline script or style, frame nothing (except the claim form)
// and may not be framed.
export function contentSecurityPolicy(frameSrc: string[] = []): string {
  return [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `frame-src ${frameSrc.length ? frameSrc.join(' ') : "'none'"}`,
  ].join('; ');
}

function sendPage(
  reply: FastifyReply,
  p: PublicPage,
  path: string | undefined,
  opts: { status?: number; frameSrc?: string[] } = {},
): FastifyReply {
  return reply
    .status(opts.status ?? 200)
    .type('text/html; charset=utf-8')
    .header('Content-Security-Policy', contentSecurityPolicy(opts.frameSrc))
    .send(page({ ...p, path }));
}

// Webhook callers and API-style clients get JSON errors, browsers get pages.
function wantsJson(req: FastifyRequest): boolean {
  if (/^\/(webhooks(\/|$|\?)|healthz)/.test(req.url)) return true;
  const accept = req.headers.accept ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

// Enough to debug a failure without logging what a message or URL may carry
// (portal tokens live in /c/ paths; signed links carry query strings).
function errSummary(err: unknown): Record<string, unknown> {
  const scrub = (s: string) => s.replace(/https?:\/\/\S+/g, '[url]').replace(/\/c\/[\w-]+/g, '/c/[token]');
  if (!(err instanceof Error)) return { message: scrub(String(err).slice(0, 200)) };
  return {
    name: err.name,
    code: (err as { code?: unknown }).code,
    message: scrub(err.message.split('\n')[0]!.slice(0, 200)),
    stack: err.stack
      ?.split('\n')
      .slice(1, 8)
      .map((l) => scrub(l.trim()))
      .join(' | '),
  };
}

function claimFormUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export async function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const base = ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, '');

  // Content is static, so each page is built once.
  const pages: Array<[string, PublicPage]> = [
    ['/', homePage()],
    ['/how-it-works', howItWorksPage()],
    ['/faq', faqPage()],
    ['/privacy', privacyPage()],
    ['/terms', termsPage()],
  ];
  for (const [path, p] of pages) {
    app.get(path, async (_req, reply) => sendPage(reply, p, path));
  }

  const formUrl = claimFormUrl(ctx.board.claimForm.embedUrl);
  if (!formUrl) ctx.log.error({}, 'public: claimForm.embedUrl is not an https URL; the claim form is not shown');
  const frameSrc = formUrl
    ? [...FORM_FRAME_SRC, ...(formUrl.hostname.endsWith('.monday.com') ? [] : [formUrl.origin])]
    : [];
  const startPage = startClaimPage(formUrl ? ctx.board.claimForm.embedUrl : null);
  app.get('/start-a-claim', async (_req, reply) => sendPage(reply, startPage, '/start-a-claim', { frameSrc }));

  // Find my claim: POST-redirect-GET, and the same answer whether or not the
  // address has claims, so the page can't be used to test addresses.
  const findForm = findClaimFormPage();
  const findSent = findClaimSentPage();
  app.get<{ Querystring: { sent?: unknown } }>('/find-my-claim', async (req, reply) =>
    sendPage(reply, req.query.sent === '1' ? findSent : findForm, '/find-my-claim'),
  );

  app.post<{ Body: Record<string, unknown> | undefined }>(
    '/find-my-claim',
    { config: { rateLimit: FIND_CLAIM_LIMIT } },
    async (req, reply) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const email = parseEmail(body.email);
      if (!email) {
        const typed = typeof body.email === 'string' ? body.email.slice(0, 254) : '';
        const p = findClaimFormPage({ email: typed, error: 'Enter a valid email address, like name@example.com.' });
        return sendPage(reply, p, '/find-my-claim', { status: 400 });
      }
      // Only bots fill the hidden field. They get the same answer, and no email.
      if (!body.website) {
        try {
          await ctx.services.auth.sendClaimLinks(email);
        } catch (err) {
          ctx.log.error({ err: errSummary(err) }, 'public: sending claim links failed');
        }
      }
      return reply.redirect('/find-my-claim?sent=1', 303);
    },
  );

  app.get('/robots.txt', async (_req, reply) =>
    reply
      .type('text/plain; charset=utf-8')
      .send(['User-agent: *', 'Disallow: /c/', 'Disallow: /admin', 'Disallow: /webhooks', '', `Sitemap: ${base}/sitemap.xml`, ''].join('\n')),
  );

  app.get('/sitemap.xml', async (_req, reply) =>
    reply
      .type('application/xml; charset=utf-8')
      .send(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          SITEMAP_PATHS.map((p) => `  <url><loc>${escapeHtml(base + p)}</loc></url>\n`).join('') +
          '</urlset>\n',
      ),
  );

  app.setNotFoundHandler(async (req, reply) => {
    if (wantsJson(req)) return reply.status(404).send({ statusCode: 404, error: 'Not Found' });
    return sendPage(reply, notFoundPage(), undefined, { status: 404 });
  });

  // Never shows error details. Keeps the status of client errors (validation 400,
  // 413, rate-limit 429), so those get a matching page.
  app.setErrorHandler(async (err, req, reply) => {
    const e = (err && typeof err === 'object' ? err : {}) as {
      statusCode?: unknown;
      headers?: unknown;
      name?: unknown;
      message?: unknown;
    };
    // ClaimantInputError messages are written for the claimant (services/errors.ts).
    const claimantMessage = e.name === 'ClaimantInputError' && typeof e.message === 'string' ? e.message : undefined;
    const status =
      typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600
        ? e.statusCode
        : claimantMessage
          ? 400
          : 500;
    if (status >= 500) {
      ctx.log.error({ err: errSummary(err), method: req.method, route: req.routeOptions.url ?? null }, 'web: request failed');
    }
    if (e.headers && typeof e.headers === 'object') reply.headers(e.headers as Record<string, string>);
    reply.header('Cache-Control', 'no-store');
    if (wantsJson(req)) return reply.status(status).send({ statusCode: status, error: STATUS_CODES[status] ?? 'Error' });
    const p =
      status === 429
        ? tooManyRequestsPage(Number(reply.getHeader('retry-after')) || undefined)
        : status === 404
          ? notFoundPage()
          : status < 500
            ? badRequestPage(status, claimantMessage)
            : serverErrorPage(status);
    return sendPage(reply, p, undefined, { status });
  });
}
