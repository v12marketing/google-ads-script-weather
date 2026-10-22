import { html, type Html } from '../html.js';
import { SITE } from '../site-info.js';
import { contactLink, ctaBand, type PublicPage } from './common.js';

export interface FaqItem {
  id: string;
  q: string;
  a: Html;
}

export const FAQ: FaqItem[] = [
  {
    id: 'how-long',
    q: 'How long does a claim take?',
    a: html`<p>Every claim is different. Claims with clear photos and receipts or estimates usually move fastest.
      You don't need to chase us: we email you each time your claim moves to a new stage, and text you too if
      you opted in. You can check where things stand on your claim page at any time.</p>`,
  },
  {
    id: 'photos',
    q: 'What photos should I include?',
    a: html`<p>Clear, well-lit photos help us most:</p>
      <ul>
        <li>The damage up close, and the whole item so we can see where the damage is</li>
        <li>The outside of the box or packaging, including any labels, if you still have it</li>
        <li>Anything that shows the size or model, like a label or tag</li>
      </ul>
      <p>If you can, keep the damaged item and its packaging until we've reviewed your claim, in case we need more photos.</p>`,
  },
  {
    id: 'add-later',
    q: 'Can I add photos or documents later?',
    a: html`<p>Yes. Open your claim page from the link in any of our emails and add them there. If a photo won't
      upload on the claim form, file your claim without it and add it on your claim page afterwards.</p>`,
  },
  {
    id: 'status',
    q: 'How do I check the status of my claim?',
    a: html`<p>Open your private claim page from the link in your confirmation email, or any later email from us.
      It shows your claim's status, what happens next, and every message between you and our team.</p>
      <p>If you get text updates, you can also text <strong>STATUS</strong> to the number we text you from,
      and we'll reply with your claim's current status.</p>`,
  },
  {
    id: 'lost-link',
    q: "I can't find my claim link. What should I do?",
    a: html`<p>Go to <a href="/find-my-claim">Find my claim</a> and enter the email address you used on your claim.
      If there are claims for that address, we'll email you their links.</p>`,
  },
  {
    id: 'code',
    q: 'Why am I being asked for a code?',
    a: html`<p>The first time you open your claim page on a new phone, computer or browser, we email a 6-digit code to the
      address on your claim. Entering it proves the claim is yours. After that, that device is remembered and you
      won't need a code there again. Codes expire after 10 minutes. We will never call or text you to ask for your code.</p>`,
  },
  {
    id: 'privacy',
    q: 'Can someone else see my claim?',
    a: html`<p>Your claim page is private. Even if someone else gets hold of your link, they would also need a code
      sent to your email before they could open it on their device. Please don't forward our emails or share your link.
      If someone is helping you with your claim, they can use the claim page on a device you have already opened it on.</p>`,
  },
  {
    id: 'payment',
    q: 'How does payment work?',
    a: html`<p>If we offer you a settlement, you review and sign it electronically. Once it's signed, your claim page
      shows a link to a secure payment form, where you choose to be paid by mailed check or by direct deposit (ACH)
      to your bank account. We'll let you know when your payment has been sent.</p>`,
  },
  {
    id: 'bank-safe',
    q: 'Is my bank information safe?',
    a: html`<p>Your bank details go straight from your browser to our finance team's secure payment form. They are never
      sent to or stored on this website, and they never appear in our emails or texts.</p>
      <p>We will never ask for your bank details by email, text or phone. If anyone does, please don't reply. Let us know at ${contactLink()}.</p>`,
  },
  {
    id: 'change-payment',
    q: 'Can I change how I get paid?',
    a: html`<p>If your payment hasn't been sent yet, send us a message from your claim page, or reply to one of our
      emails, and we'll help you change it. Please don't put bank details in a message or email.</p>`,
  },
  {
    id: 'texts',
    q: 'Will you text me? How do I stop texts?',
    a: html`<p>Only if you ticked the box for text updates on the claim form. We text about your claim only: status updates,
      replies from our team, and answers when you text STATUS. Message frequency varies. Message and data rates may apply.</p>
      <p>Reply <strong>STOP</strong> at any time to stop texts, or <strong>HELP</strong> for help. You'll still get updates
      by email. See our <a href="/terms#sms-terms">SMS terms</a>.</p>`,
  },
  {
    id: 'denied',
    q: 'What if my claim is denied?',
    a: html`<p>We'll let you know by email, and your claim page will show the decision. If you have questions about it, or
      information we didn't see, such as more photos, receipts or an estimate, send it to us from your claim page or reply
      to the email, and we'll review it.</p>`,
  },
  {
    id: 'contact',
    q: 'How do I contact you?',
    a: html`<p>The quickest way is to send a message from your claim page, or reply to any email or text from us. Your
      message goes straight to the team handling your claim.</p>
      <p>You can also email ${contactLink()}. Please include your claim number (it starts with HDC) if you have one.</p>`,
  },
];

export const faqItem = (f: FaqItem, open = false): Html =>
  html`<details id="${f.id}"${open ? html` open` : ''}>
  <summary>${f.q}</summary>
  <div class="answer">${f.a}</div>
</details>`;

export function faqPage(): PublicPage {
  return {
    title: 'Frequently asked questions',
    description: `Answers about filing a delivery damage claim with ${SITE.brandName}: photos, status updates, your private claim page, payment and text messages.`,
    body: html`<h1>Frequently asked questions</h1>
<p class="lead">Quick answers about filing a claim, following its progress and getting paid.</p>
<div class="faq">
${FAQ.map((f) => faqItem(f))}
</div>
<p class="muted">Still have a question? Email ${contactLink()} and we'll get back to you.</p>
${ctaBand()}`,
  };
}
