import { html, raw } from '../html.js';
import { SITE } from '../site-info.js';
import { contactLink, type PublicPage } from './common.js';

// Exact wording required for A2P 10DLC registration. Do not paraphrase.
export const SMS_PRIVACY_STATEMENT =
  'Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes. ' +
  'Text messaging originator opt-in data and consent will not be shared with any third parties.';

export function privacyPage(): PublicPage {
  return {
    title: 'Privacy Policy',
    description: `How ${SITE.brandName} collects, uses and protects your information when you file and manage a delivery damage claim.`,
    body: html`${raw('<!-- DRAFT for counsel review. Not final legal text: bracketed items must be completed and the whole policy approved before launch. -->')}
<article class="prose">
<h1>Privacy Policy</h1>
<p class="meta">Effective date: ${SITE.effectiveDate}</p>

<p>${SITE.legalEntityName} ("we", "us") runs ${SITE.domain} to handle claims for items damaged during home delivery.
This policy explains what information we collect when you use this website or file a claim, how we use it, and the
choices you have.</p>

<h2>Information we collect</h2>
<ul>
  <li><strong>Contact details:</strong> your name, email address, phone number and mailing address.</li>
  <li><strong>Delivery details:</strong> order number, delivery date, delivery address and what was delivered.</li>
  <li><strong>Claim details:</strong> what happened, what was damaged, and the amount you claim.</li>
  <li><strong>Photos and documents</strong> you upload, such as photos of the damage, receipts and repair estimates.</li>
  <li><strong>Messages</strong> between you and our team, including replies you send by email or text.</li>
  <li><strong>Settlement records:</strong> your electronic signature and when you signed.</li>
  <li><strong>Security information:</strong> your IP address, browser and device type, and a cookie that remembers a device
    you have verified with a one-time code, so we can protect your claim from unauthorized access.</li>
</ul>
<p>If you choose direct deposit, you enter your bank details on our finance team's secure payment form. Those details go
directly to our finance team. They are not sent to or stored on this website.</p>

<h2>How we use your information</h2>
<ul>
  <li>To review, decide, settle and pay your claim</li>
  <li>To contact you about your claim by email, and by text message if you opted in</li>
  <li>To keep your claim page secure and prevent fraud</li>
  <li>To keep records and meet our legal obligations</li>
</ul>
<p>We do not sell your personal information, and we do not use it for advertising. This website does not use advertising
or analytics trackers. It uses only the cookies needed to keep your claim page secure.</p>

<h2>Who we share it with</h2>
<p>We share your information only as needed to handle your claim:</p>
<ul>
  <li><strong>Service providers</strong> who work for us under contract: our email and text message provider, the
    work-management platform our claims team uses to keep claim records, our electronic signature provider, and our website
    hosting provider. They may use your information only to provide their services to us.</li>
  <li><strong>Banks and payment processors</strong>, to send your payment.</li>
  <li>[Confirm with counsel: the delivery company and its insurers, where needed to assess or pay your claim.]</li>
  <li><strong>Authorities</strong>, when the law requires it, or to prevent fraud or protect people's rights and safety.</li>
</ul>

<h2 id="text-messages">Text messages</h2>
<p>If you opt in to text updates, we use your mobile number only to send messages about your claim.
${SMS_PRIVACY_STATEMENT}</p>
<p>Reply STOP to stop text messages, or HELP for help. See our <a href="/terms#sms-terms">SMS terms</a>.</p>

<h2>How long we keep it</h2>
<p>We keep claim records for as long as ${SITE.legalEntityName} needs them to handle the claim and meet its legal, accounting
and insurance obligations: ${SITE.retentionPeriod}. After that, we delete or anonymize them.</p>

<h2>How we protect it</h2>
<p>This website uses encryption (HTTPS). Your claim page can only be opened with a private link and, on a new device, a
one-time code emailed to you. Access to claim records is limited to the people who need it to handle claims. No system is
completely secure, so please keep your claim link and codes to yourself.</p>

<h2>Your choices and rights</h2>
<p>You can ask us to access, correct or delete your information, subject to the records we must keep by law.
Depending on where you live, you may have other privacy rights, and we will honor them as the law requires. We won't treat
you differently for using them. To make a request, email ${contactLink()}. We may need to confirm your identity first.</p>

<h2>Children</h2>
<p>This website is not meant for children under 13, and we do not knowingly collect their information.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy. We'll post the new version here with a new effective date.</p>

<h2>Contact us</h2>
<p>${SITE.legalEntityName}<br>${SITE.mailingAddress}<br>Email: ${contactLink()}</p>
</article>`,
  };
}
