import { html } from '../html.js';
import { checklist, contactLink, smsOptInNote, type PublicPage } from './common.js';
import { icon } from './icons.js';

const READY = [
  'Order or delivery details: order number, delivery date and the delivery address',
  'Photos of the damage, up close and of the whole item',
  'Photos of the box or packaging, if you still have it',
  'Receipts, invoices or repair estimates, if you have them',
  'The amount you are claiming',
];

// embedUrl comes from config/board.json (claimForm.embedUrl); html`` escapes it.
// null when the configured URL isn't https, so we never frame or link anything else.
export function startClaimPage(embedUrl: string | null): PublicPage {
  const form = embedUrl
    ? html`<div class="claim-form-shell">
    <iframe class="claim-form-frame" src="${embedUrl}" title="Claim form" width="100%" loading="lazy"></iframe>
  </div>
  <p class="frame-fallback">Form not loading? <a href="${embedUrl}" target="_blank" rel="noopener">Open it in a new window</a></p>`
    : html`<div class="alert alert-error" role="alert">The claim form isn't available right now. Please try again later,
    or email ${contactLink()} and we'll help you file your claim.</div>`;
  return {
    title: 'Start a claim',
    description: 'File a delivery damage claim online. Have your order details, photos and any receipts or estimates ready.',
    body: html`<h1>Start a claim</h1>
<p class="lead">Fill in the form below to tell us what was damaged. You can add more photos and documents after you file.</p>

<div class="grid-2">
  <section class="card" aria-labelledby="ready-title">
    <h2 id="ready-title">Have these ready</h2>
    ${checklist(READY)}
    <p class="small muted">Missing something? File now anyway. You can add it later from your claim page.</p>
  </section>
  <section class="callout" aria-labelledby="sms-title">
    ${icon('phone', 'icon callout-icon')}
    <div>
      <h2 id="sms-title">Text updates (optional)</h2>
      ${smsOptInNote()}
    </div>
  </section>
</div>

<section class="section" aria-labelledby="form-title">
  <h2 id="form-title">Claim form</h2>
  <p class="section-lead">As soon as you submit, we'll email you your claim number.</p>
  ${form}
</section>

<section class="section callout" aria-labelledby="after-title">
  ${icon('mail', 'icon callout-icon')}
  <div>
    <h2 id="after-title">After you submit</h2>
    <p>We'll email you your claim number right after you submit, with a private link to your claim page.
      If it isn't in your inbox within a few minutes, check your spam or junk folder.</p>
    <p>Lost the email later? Use <a href="/find-my-claim">Find my claim</a> to get your link again.</p>
  </div>
</section>`,
  };
}
