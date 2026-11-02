import { html, type Html } from '../html.js';
import { contactLink, type PublicPage } from './common.js';

const errorBody = (code: number, heading: string, body: Html): Html => html`<div class="error-page">
<p class="error-code">Error ${code}</p>
<h1>${heading}</h1>
${body}
<div class="actions">
  <a class="btn btn-primary" href="/">Go to the home page</a>
  <a class="btn btn-secondary" href="/find-my-claim">Find my claim</a>
</div>
</div>`;

export function notFoundPage(): PublicPage {
  return {
    title: 'Page not found',
    description: "We couldn't find that page.",
    noindex: true,
    body: errorBody(
      404,
      "We can't find that page",
      html`<p class="lead">The address may be mistyped, or the page may have moved.</p>
<p>If you followed a link to your claim from one of our emails, it may have been replaced by a newer one. Use
  <a href="/find-my-claim">Find my claim</a> and we'll email you a fresh link.</p>`,
    ),
  };
}

export function tooManyRequestsPage(retryAfterSeconds?: number): PublicPage {
  const minutes = retryAfterSeconds && retryAfterSeconds > 0 ? Math.ceil(retryAfterSeconds / 60) : null;
  const wait = minutes ? `about ${minutes} minute${minutes === 1 ? '' : 's'}` : 'a few minutes';
  return {
    title: 'Too many tries',
    description: 'Too many tries. Please wait and try again.',
    noindex: true,
    body: errorBody(
      429,
      'Too many tries',
      html`<p class="lead">To keep claims secure, we limit how often this can be done. Please wait ${wait} and try again.</p>
<p>Need help sooner? Email ${contactLink()}.</p>`,
    ),
  };
}

// Any other 4xx: the request itself was the problem. Never echoes error details.
export function badRequestPage(code: number, message?: string): PublicPage {
  const heading =
    code === 413 ? 'That was too large to send' : code === 401 || code === 403 ? "You don't have access to this page" : "We couldn't complete that request";
  return {
    title: heading,
    description: heading,
    noindex: true,
    body: errorBody(
      code,
      heading,
      html`<p class="lead">${message ?? 'Please go back and try again.'}</p>
<p>If this keeps happening, email ${contactLink()} and we'll help.</p>`,
    ),
  };
}

export function serverErrorPage(code = 500): PublicPage {
  return {
    title: 'Something went wrong',
    description: 'Something went wrong on our side.',
    noindex: true,
    body: errorBody(
      code,
      'Something went wrong on our side',
      html`<p class="lead">Sorry about that. Nothing you did caused this. Please try again in a few minutes.</p>
<p>If it keeps happening, email ${contactLink()} and we'll help.</p>`,
    ),
  };
}
