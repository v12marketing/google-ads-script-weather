import { html, raw, type Html } from './html.js';

export const SITE_NAME = 'Home Delivery Claims';

export interface PageOptions {
  title: string;
  description?: string;
  body: Html;
  // Extra stylesheets under /static/, e.g. 'portal.css'.
  styles?: string[];
  // Scripts under /static/, loaded with defer.
  scripts?: string[];
  // Portal and admin pages are never indexed.
  noindex?: boolean;
  // Hide the marketing nav (portal, admin).
  minimalHeader?: boolean;
  // Path of the current page, to mark the active nav link.
  path?: string;
}

const NAV: Array<[string, string]> = [
  ['/start-a-claim', 'Start a claim'],
  ['/how-it-works', 'How it works'],
  ['/faq', 'FAQ'],
  ['/find-my-claim', 'Find my claim'],
];

export function page(o: PageOptions): string {
  const title = o.title === SITE_NAME ? SITE_NAME : `${o.title} | ${SITE_NAME}`;
  return (
    '<!doctype html>\n' +
    html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${o.description ? html`<meta name="description" content="${o.description}">` : ''}
${o.noindex ? raw('<meta name="robots" content="noindex, nofollow">') : ''}
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/site.css">
${(o.styles ?? []).map((s) => html`<link rel="stylesheet" href="/static/${s}">`)}
${(o.scripts ?? []).map((s) => html`<script src="/static/${s}" defer></script>`)}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/">${SITE_NAME}</a>
    ${
      o.minimalHeader
        ? ''
        : html`<nav class="site-nav" aria-label="Main">
      ${NAV.map(
        ([href, label]) =>
          html`<a href="${href}"${o.path === href ? raw(' aria-current="page"') : ''}>${label}</a>`,
      )}
    </nav>`
    }
  </div>
</header>
<main id="main" class="wrap">
${o.body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <nav aria-label="Legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/faq">FAQ</a></nav>
    <p>&copy; ${new Date().getFullYear()} ${SITE_NAME}</p>
  </div>
</footer>
</body>
</html>`.value
  );
}
