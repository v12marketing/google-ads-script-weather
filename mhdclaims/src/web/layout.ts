import { html, raw, type Html } from './html.js';
import { SITE } from './site-info.js';

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
<meta name="theme-color" content="#02244d">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png">
<link rel="preload" href="/static/fonts/open-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/static/fonts/montserrat-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/site.css">
${(o.styles ?? []).map((s) => html`<link rel="stylesheet" href="/static/${s}">`)}
${(o.scripts ?? []).map((s) => html`<script src="/static/${s}" defer></script>`)}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/"><img src="/static/brand/logo.webp" width="505" height="200" alt="${SITE.domain} home"></a>
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
    <p class="footer-brand">${SITE.domain}</p>
    <p class="footer-tagline">${SITE.descriptor} · ${SITE.tagline}</p>
    <nav aria-label="Legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/faq">FAQ</a></nav>
    <p>&copy; ${new Date().getFullYear()} ${SITE.legalEntityName}</p>
  </div>
</footer>
</body>
</html>`.value
  );
}
