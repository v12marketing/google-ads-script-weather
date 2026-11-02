import { html, type Html } from '../html.js';
import { SITE } from '../site-info.js';
import { icon } from './icons.js';

// What a page module hands to layout.page(); the route adds the path.
export interface PublicPage {
  title: string;
  description: string;
  body: Html;
  noindex?: boolean;
}

export const contactLink = (): Html => html`<a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a>`;

export const WHAT_YOU_NEED: string[] = [
  'Your order or delivery details: order number, delivery date and address',
  'Photos of the damage, and of the packaging if you still have it',
  'Receipts, invoices or repair estimates, if you have them',
  'The amount you are claiming',
  'An email address, and a mobile number if you would like text updates',
];

export const checklist = (items: readonly string[]): Html =>
  html`<ul class="checklist">${items.map((i) => html`<li>${icon('check')}<span>${i}</span></li>`)}</ul>`;

// Shown next to the claim form's opt-in box (A2P 10DLC call-to-action wording).
export const smsOptInNote = (): Html => html`<p>
  The claim form has an optional box to get text updates. If you tick it, ${SITE.brandName} will text the
  mobile number you give us with updates about your claim. Message frequency varies. Message and data rates
  may apply. Reply STOP to cancel or HELP for help. You don't have to agree to texts to file a claim.
</p>
<p class="small">See our <a href="/terms#sms-terms">SMS terms</a> and <a href="/privacy">Privacy Policy</a>.</p>`;

export const ctaBand = (heading = 'Ready to file your claim?'): Html => html`<section class="cta-band" aria-labelledby="cta-title">
  <h2 id="cta-title">${heading}</h2>
  <p>File online, from your phone or computer. You can add more photos and documents later.</p>
  <div class="actions actions-center">
    <a class="btn btn-primary btn-lg" href="/start-a-claim">Start a claim</a>
    <a class="btn btn-on-dark btn-lg" href="/find-my-claim">Find my claim</a>
  </div>
</section>`;
