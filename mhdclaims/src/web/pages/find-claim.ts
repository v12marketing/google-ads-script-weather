import { html } from '../html.js';
import { contactLink, type PublicPage } from './common.js';
import { icon } from './icons.js';

export const CLAIM_LINKS_SENT = "If there are claims for that address, we've emailed the links.";

const intro = html`<h1>Find my claim</h1>
<p class="lead">Enter the email address you used on your claim form. We'll email you a private link to each of your claims.</p>`;

export function findClaimFormPage(o: { email?: string; error?: string } = {}): PublicPage {
  const err = o.error;
  return {
    title: 'Find my claim',
    description: 'Lost your claim link? Enter your email address and we will email you a private link to your claim.',
    body: html`<div class="narrow">
${intro}
${err ? html`<div class="alert alert-error" role="alert" id="form-error">${err}</div>` : ''}
<form class="card" method="post" action="/find-my-claim">
  <div class="field">
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" value="${o.email ?? ''}" required maxlength="254"
      autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false"
      ${err ? html`aria-invalid="true" aria-describedby="form-error email-hint"` : html`aria-describedby="email-hint"`}>
    <p class="hint" id="email-hint">Use the same address you entered on the claim form.</p>
  </div>
  <div class="hp" aria-hidden="true">
    <label for="website">Leave this field empty</label>
    <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
  </div>
  <button class="btn btn-primary btn-block" type="submit">Email my claim links</button>
</form>
<p class="small muted">Haven't filed yet? <a href="/start-a-claim">Start a claim</a>.</p>
</div>`,
  };
}

export function findClaimSentPage(): PublicPage {
  return {
    title: 'Check your email',
    description: 'We have emailed links to any claims for that address.',
    noindex: true,
    body: html`<div class="narrow">
<h1>Check your email</h1>
<div class="alert alert-success sent-alert" role="status">
  ${icon('mail', 'icon')}
  <p>${CLAIM_LINKS_SENT}</p>
</div>
<p>The email has a private link to each claim. Please don't forward it or share the link.</p>
<h2>Didn't get it?</h2>
<ul>
  <li>Wait a few minutes, then check your spam or junk folder.</li>
  <li>Make sure you used the same email address as on your claim form. You can <a href="/find-my-claim">try another address</a>.</li>
  <li>Still stuck? Email ${contactLink()} with your name and delivery address, and we'll help.</li>
</ul>
</div>`,
  };
}
