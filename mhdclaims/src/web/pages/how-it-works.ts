import { html, type Html } from '../html.js';
import { contactLink, ctaBand, type PublicPage } from './common.js';
import { icon } from './icons.js';

interface Stage {
  name: string;
  text: Html;
  end?: boolean;
}

// One entry per claimant-facing status (see StatusKey), in the order a claim moves.
const STAGES: Stage[] = [
  {
    name: 'Claim received',
    text: html`<p>We email you your claim number and a private link to your claim page as soon as you submit the form,
      and text you too if you opted in.</p>`,
  },
  {
    name: 'Under review',
    text: html`<p>Our claims team looks at your photos and the details you gave us.</p>`,
  },
  {
    name: 'More information needed',
    text: html`<p>If we need something else, such as another photo, a receipt or a repair estimate, we'll tell you exactly
      what. Add it on your claim page, or reply to our email or text.</p>`,
  },
  {
    name: 'Estimate in progress',
    text: html`<p>We're working out the cost to repair or replace what was damaged. We may ask you for an estimate or a receipt.</p>`,
  },
  {
    name: 'Settlement offered',
    text: html`<p>We send you a settlement agreement to review and sign electronically. You can see the amount on your claim
      page and in the agreement. For your privacy, we don't put amounts in emails or texts.</p>`,
  },
  {
    name: 'Payment details',
    text: html`<p>Once you've signed, your claim page shows a link to a secure payment form. Choose a mailed check, or direct
      deposit (ACH) to your bank account. Your bank details go straight to our finance team's secure form, not to this website.</p>`,
  },
  {
    name: 'Payment sent',
    text: html`<p>We let you know when your payment is on its way.</p>`,
  },
  {
    name: 'Closed or denied',
    text: html`<p>When your claim is complete, we close it. If we can't approve a claim, we'll let you know by email and on
      your claim page. If you have information we didn't see, send it to us and we'll review it.</p>`,
    end: true,
  },
];

export function howItWorksPage(): PublicPage {
  return {
    title: 'How it works',
    description:
      'What happens after you file a delivery damage claim: each stage of your claim, your private claim page, updates by email and text, and how payment works.',
    body: html`<h1>How it works</h1>
<p class="lead">From the moment you file to the day you're paid, here's what to expect. We keep you updated at every step,
  so you always know where your claim stands.</p>

<section class="section" aria-labelledby="stages-title">
  <h2 id="stages-title">The stages of a claim</h2>
  <p class="section-lead">Your claim page shows which stage your claim is at. Each time it moves on, we email you, and text you if you opted in.</p>
  <ol class="timeline">
    ${STAGES.map((s) => html`<li${s.end ? html` class="end"` : ''}><h3>${s.name}</h3>${s.text}</li>`)}
  </ol>
</section>

<section class="section grid-2" aria-label="Your claim page and staying in touch">
  <div class="card">
    <h2>${icon('lock', 'icon heading-icon')} Your private claim page</h2>
    <p>Every email we send includes a private link to your claim page. There you can:</p>
    <ul>
      <li>See your claim's status and what happens next</li>
      <li>Read and send messages to our claims team</li>
      <li>Add photos and documents</li>
      <li>Review your settlement and find the payment form</li>
    </ul>
    <p>There's no account or password. The first time you open your claim page on a new phone, computer or browser, we email
      a one-time 6-digit code to the address on your claim. It expires after 10 minutes. After that, the device is remembered.</p>
    <p class="small muted">Please don't forward our emails or share your link. Lost it? Use <a href="/find-my-claim">Find my claim</a>.</p>
  </div>
  <div class="card">
    <h2>${icon('chat', 'icon heading-icon')} Staying in touch</h2>
    <ul>
      <li><strong>Reply to any email or text</strong> from us. Your reply goes straight to the team handling your claim.</li>
      <li><strong>Send a message</strong> from your claim page.</li>
      <li><strong>Text STATUS</strong> to the number we text you from, and we'll reply with your claim's current status.</li>
      <li><strong>Reply STOP</strong> to stop text messages, or <strong>HELP</strong> for help. We'll keep you updated by email.</li>
    </ul>
    <p>You can also email ${contactLink()}. Please include your claim number.</p>
  </div>
</section>

<section class="section callout" aria-labelledby="pay-title">
  ${icon('shield', 'icon callout-icon')}
  <div>
    <h2 id="pay-title">Getting paid safely</h2>
    <p>Payment is by mailed check or direct deposit (ACH). If you choose direct deposit, you enter your bank details on our
      finance team's secure payment form, linked from your claim page after you sign your settlement. They are never sent to
      or stored on this website.</p>
    <p>We will never ask for your bank details, or for your one-time code, by email, text or phone.</p>
  </div>
</section>

${ctaBand()}`,
  };
}
