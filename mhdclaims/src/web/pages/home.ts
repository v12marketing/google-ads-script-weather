import { html } from '../html.js';
import { SITE } from '../site-info.js';
import { checklist, ctaBand, WHAT_YOU_NEED, type PublicPage } from './common.js';
import { FAQ, faqItem } from './faq.js';
import { heroArt, icon } from './icons.js';

const TEASER_IDS = ['how-long', 'status', 'payment', 'bank-safe'];

export function homePage(): PublicPage {
  const teaser = FAQ.filter((f) => TEASER_IDS.includes(f.id));
  return {
    title: 'File a delivery damage claim online',
    description:
      'Delivery damaged? File a claim online with photos, follow its progress on your private claim page, and get paid by check or direct deposit.',
    body: html`<section class="hero" aria-labelledby="hero-title">
  <div class="hero-text">
    <p class="eyebrow">${SITE.deliveryCompanyName ? html`<span>For deliveries by <span class="nowrap">${SITE.deliveryCompanyName}</span></span>` : 'Delivery damage claims'}</p>
    <h1 id="hero-title">Delivery damaged? File a claim online.</h1>
    <p class="lead">Tell us what happened and add a few photos. We'll review your claim, keep you updated by email or
      text, and pay approved claims by check or direct deposit.</p>
    <div class="actions">
      <a class="btn btn-primary btn-lg" href="/start-a-claim">Start a claim</a>
      <a class="btn btn-secondary btn-lg" href="/find-my-claim">Find my claim</a>
    </div>
    <p class="small muted">Already filed? Your confirmation email has a private link to your claim.</p>
  </div>
  <div class="hero-art">${heroArt}</div>
</section>

<section class="section" aria-labelledby="how-title">
  <h2 id="how-title">How it works</h2>
  <ol class="steps">
    <li class="step">
      <span class="step-icon">${icon('camera')}</span>
      <span class="step-num" aria-hidden="true">Step 1</span>
      <h3>File your claim with photos</h3>
      <p>Fill in the online claim form and add photos of the damage. You'll get your claim number by email right away.</p>
    </li>
    <li class="step">
      <span class="step-icon">${icon('chat')}</span>
      <span class="step-num" aria-hidden="true">Step 2</span>
      <h3>We review and keep you updated</h3>
      <p>Our claims team reviews your claim. We email you at every step, and text you too if you choose.</p>
    </li>
    <li class="step">
      <span class="step-icon">${icon('payment')}</span>
      <span class="step-num" aria-hidden="true">Step 3</span>
      <h3>Settle and get paid</h3>
      <p>If we offer a settlement, you sign it online and choose payment by mailed check or direct deposit.</p>
    </li>
  </ol>
  <p><a href="/how-it-works">More about how it works</a></p>
</section>

<section class="section grid-2" aria-label="Before you start">
  <div class="card">
    <h2>What you'll need</h2>
    ${checklist(WHAT_YOU_NEED)}
    <p class="small muted">Don't have everything? You can still file now and add documents later.</p>
  </div>
  <div class="callout">
    ${icon('mail', 'icon callout-icon')}
    <div>
      <h2>Updates come to you</h2>
      <p>Each time your claim moves forward, we email you, and text you too if you opt in. No need to call or chase us.</p>
      <p>Every email has a private link to your claim page, where you can check the status, message our team and add photos
        or documents. There's no account or password: the first time you open it on a new device, we email you a one-time code.</p>
    </div>
  </div>
</section>

<section class="section" aria-labelledby="faq-title">
  <h2 id="faq-title">Common questions</h2>
  <div class="faq">
    ${teaser.map((f) => faqItem(f))}
  </div>
  <p><a href="/faq">See all questions</a></p>
</section>

${ctaBand()}`,
  };
}
