import { html, raw } from '../html.js';
import { SITE } from '../site-info.js';
import { contactLink, type PublicPage } from './common.js';

export function termsPage(): PublicPage {
  return {
    title: 'Terms of Use',
    description: `The terms for using ${SITE.domain}, filing a claim, electronic communications and signatures, and text message updates.`,
    body: html`${raw('<!-- DRAFT for counsel review. Not final legal text: bracketed items must be completed and the whole document approved before launch. -->')}
<article class="prose">
<h1>Terms of Use</h1>
<p class="meta">Effective date: ${SITE.effectiveDate}</p>

<p>These terms apply when you use ${SITE.domain} (the "site"), which ${SITE.legalEntityName} ("we", "us") runs to handle
claims for items damaged during home delivery. By using the site or filing a claim, you agree to these terms and to our
<a href="/privacy">Privacy Policy</a>.</p>

<h2>Using the site</h2>
<ul>
  <li>Use the site only to file and manage your own claim, or a claim you are authorized to handle.</li>
  <li>Keep your private claim link and one-time codes to yourself. Don't try to open anyone else's claim.</li>
  <li>Don't interfere with the site, upload harmful files, or try to get around its security.</li>
</ul>
<p>We may suspend access to a claim page to protect it, for example if we see unusual activity.</p>

<h2>Your claim</h2>
<p>Everything you submit must be true, accurate and complete to the best of your knowledge, including photos, documents
and amounts. Submitting false or misleading information may lead to your claim being denied and may be reported to the
authorities.</p>
<p>You confirm that you have the right to share the photos and documents you upload, and you allow us to use them to
handle your claim. Filing a claim does not guarantee that it will be approved or paid. Each claim is reviewed on its
own facts.</p>

<h2 id="electronic">Electronic communications and signatures</h2>
<p>You agree that we may send you notices, updates and documents about your claim electronically, by email, on your claim
page, and by text message if you opted in. Electronic notices count as written notice.</p>
<p>You agree to review and sign your settlement agreement and related documents electronically, and that your electronic
signature is as binding as a handwritten one. You can ask for a paper copy of any document you signed, or withdraw your
consent to electronic records, by emailing ${contactLink()}. [Confirm with counsel: E-SIGN Act disclosures, including
hardware and software requirements and any fee for paper copies.]</p>

<h2 id="sms-terms">SMS terms</h2>
<ul>
  <li><strong>Program:</strong> ${SITE.smsProgramName}.</li>
  <li><strong>What we send:</strong> text messages about your claim, such as status updates, replies from our claims team,
    and answers when you text STATUS. We do not send marketing messages.</li>
  <li><strong>How you join:</strong> by ticking the text-updates box on the claim form. You don't have to agree to texts to
    file a claim.</li>
  <li><strong>Message frequency varies.</strong> It depends on how your claim progresses.</li>
  <li><strong>Message and data rates may apply.</strong></li>
  <li><strong>To stop:</strong> reply STOP at any time. We'll confirm, and send no more texts unless you reply START.
    We'll keep you updated by email.</li>
  <li><strong>For help:</strong> reply HELP, or email ${contactLink()}.</li>
  <li>Carriers are not liable for delayed or undelivered messages.</li>
  <li>See our <a href="/privacy#text-messages">Privacy Policy</a> for how we handle your mobile number.</li>
</ul>

<h2>The site is provided as is</h2>
<p>We work to keep the site available and accurate, but we can't promise it will always be available or error-free.
[Counsel to provide disclaimer and limitation of liability wording.]</p>

<h2>Governing law</h2>
<p>These terms are governed by the laws of ${SITE.governingLawState}, without regard to its conflict of laws rules.</p>

<h2>Changes to these terms</h2>
<p>We may update these terms. We'll post the new version here with a new effective date.</p>

<h2>Contact us</h2>
<p>${SITE.legalEntityName}<br>${SITE.mailingAddress}<br>Email: ${contactLink()}</p>
</article>`,
  };
}
