import { createHash } from 'node:crypto';
import type { ContactIdentity } from '../adapters/highlevel/types.js';
import type { Claim, TemplateKey, TemplateVars } from '../domain/types.js';
import { html, type Html } from '../web/html.js';
import { cleanName, firstNameOf, formatUtc, onceFor } from './claim-fields.js';
import type { CoreContext, Notifier, NotifyResult, Services } from './contracts.js';
import { renderEmailHtml, renderEmailText, type EmailButton } from './email-html.js';
import { PermanentJobError } from './jobs.js';
import { EMAIL_ONLY_TEMPLATE_KEYS, NO_CLAIM_LINK_TEMPLATE_KEYS } from './templates.js';

// Sends claimant email/SMS through HighLevel. Never logs message bodies, codes,
// links or contact details: only the item id, template key and what was sent.
//
// HighLevel sends to the contact's own email and phone, and its upsert matches an
// existing contact on email OR phone, overwriting the other. So a claim's
// messages may only go through a contact whose email is the claim's (texts: whose
// phone is the claim's), checked against HighLevel before every send, and an
// upsert for one claim must never rewrite the email of another claim's contact.

export const CLAIMANT_TAG = 'hdc-claimant';

// HighLevel has no contact for the claim that reaches only the claim's own email
// (for a claim without one: no email at all). Nothing was sent and the team has
// been told on the item; retrying can't help until the details are fixed.
export class ContactConflictError extends PermanentJobError {}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a?.trim() && a.trim().toLowerCase() === b?.trim().toLowerCase();
const digits = (p: string | null | undefined): string => (p ?? '').replace(/\D/g, '');
const samePhone = (a: string | null | undefined, b: string | null | undefined): boolean => !!digits(a) && digits(a) === digits(b);
// For one-time note keys, so contact details don't end up in processed_events.
const keyHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Email only to a contact with the claim's email. A claim without one must not
// use a contact that has an email either: HighLevel would email that address
// (the settlement document goes to the contact).
const emailFits = (c: Claim, k: ContactIdentity): boolean => (c.email?.trim() ? sameEmail(k.email, c.email) : !k.email?.trim());
const smsFits = (c: Claim, k: ContactIdentity): boolean => samePhone(k.phone, c.phone);
// A claim without an email is only ever texted through contactFor (its
// settlement goes through ensureContact, which keeps the rule above). A text
// reaches the claim's own phone whatever email the contact has, e.g. one the
// same person's later claim, filed online with this phone, added to it.
const textFits = (c: Claim, k: ContactIdentity): boolean => !c.email?.trim() && smsFits(c, k);

// "https://forms.monday.com/forms/abc" from the payment form URL (no query).
const urlPrefix = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
};

export function createNotifier(ctx: CoreContext, services: Services): Notifier {
  const { repo, highlevel, monday, config, board, log } = ctx;

  // The only URLs an email turns into links: our site and the payment form.
  const linkPrefixes = [config.PUBLIC_BASE_URL, urlPrefix(board.paymentForm.url)].filter(Boolean);
  const logoUrl = `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/static/brand/email-logo.png`;

  const smsAllowed = (c: Claim): boolean => config.SMS_ENABLED && c.smsOptIn && !c.smsOptedOut && !!c.phone?.trim();

  // The caller's copy may predate a STOP reply or an earlier attempt's contact upsert.
  const current = (claim: Claim): Claim => {
    const fresh = repo.getClaim(claim.itemId);
    return fresh ? { ...claim, smsOptedOut: fresh.smsOptedOut, highlevelContactId: fresh.highlevelContactId } : claim;
  };

  const numbers = (claims: Claim[]): string => [...new Set(claims.map((o) => o.claimNumber))].join(', ');

  const conflictNote = (claim: Claim, others: Claim[]): Html =>
    claim.email?.trim()
      ? html`<p>Emails and texts to the claimant are on hold for this claim: HighLevel matched its email and phone to a contact whose email address is not this claim's${others.length ? html`, which is also used by claim ${numbers(others)}` : ''}, so they would reach someone else.</p>
<p>Check the email and phone on this item and the contact in HighLevel. Once they are fixed, retry the failed job in /admin (or set the status again) to send.</p>`
      : html`<p>Texts to the claimant are on hold for this claim: its phone number is on a HighLevel contact that has an email address${others.length ? html` (claim ${numbers(others)} has this phone number too)` : ''}, and this claim has no email, so HighLevel could send this claim's documents to that address.</p>
<p>Add the claimant's email to this item, or fix the contact in HighLevel.</p>`;

  const smsOffNote = (phoneShared: Claim[], emailShared: Claim[]): Html => {
    const why = [
      phoneShared.length ? html`its phone number is also on claim ${numbers(phoneShared)}, which has a different email address` : null,
      emailShared.length ? html`its email address is also on claim ${numbers(emailShared)}, which has a different phone number` : null,
    ].filter((w): w is Html => !!w);
    return html`<p>Texts are off for this claim: ${why.length ? why.map((w, i) => html`${i ? ', and ' : ''}${w}`) : 'HighLevel has its phone number on another contact'}. HighLevel keeps one contact per email address and phone number, so texts could reach someone else. Emails still go to this claim's email address.</p>
<p>If the claims belong to the same person, give them the same email and phone. Otherwise correct the details on this item.</p>`;
  };

  const contactName = (c: Claim): string => cleanName(c.claimantName) || firstNameOf(c.firstName) || c.claimNumber;
  const offeredLabel = Object.entries(board.statuses).find(([, k]) => k === 'settlement_offered')?.[0] ?? 'Settlement offered';

  // The claim moved to another contact while its settlement document is out:
  // the document stays with the contact it went to (and its signature is still
  // recognised), but the claimant may not be able to reach it. Once per document.
  async function noteSettlementLeftBehind(itemId: string, contactId: string): Promise<void> {
    const c = repo.getClaim(itemId);
    if (!c?.settlementSentAt || c.settlementSignedAt || (c.settlementContactId ?? contactId) === c.highlevelContactId) return;
    const refs = repo.getSettlementRefs(itemId);
    await onceFor(ctx, `contact-moved-settlement:${itemId}:${refs.documentId ?? refs.referenceId ?? c.settlementSentAt}`, (once) =>
      monday.createUpdate(
        itemId,
        html`<p>The settlement document sent ${formatUtc(c.settlementSentAt)} went to the claimant's email and phone as they were before this change, and stays there: it can still be signed from there, and the signature will be recognised.</p>
<p>If the claimant can't get to it, void it in HighLevel (Payments → Documents &amp; Contracts) and set the status to ${offeredLabel} again: a new document then goes to their current details.</p>`.value,
        once,
      ),
    ).catch((err) => log.warn({ itemId, err: errText(err) }, 'notifier: posting the settlement note failed'));
  }

  // A phone the claim no longer has (changed or cleared on the board) stays on
  // its HighLevel contact: the upsert never sends a missing phone. Left there, a
  // later claim with that number would match the contact on it, and HighLevel
  // would give that contact the new claim's email. So it comes off each contact
  // the claim used that still has it, unless another claim on that contact has
  // it too. Best effort: the takeover check in syncContact is the backstop.
  async function dropFormerPhone(claim: Claim, formerPhone: string, contactIds: Array<string | null>): Promise<void> {
    if (samePhone(formerPhone, claim.phone)) return;
    for (const id of new Set(contactIds.filter((v): v is string => !!v))) {
      try {
        const k = await highlevel.getContact(id);
        if (!k || !samePhone(k.phone, formerPhone)) continue;
        if (repo.findClaimsByContact(id).some((o) => o.itemId !== claim.itemId && samePhone(o.phone, formerPhone))) continue;
        await highlevel.updateContact(id, { phone: null });
        log.info({ itemId: claim.itemId, contactId: id }, "notifier: took the claim's former phone off a HighLevel contact");
      } catch (err) {
        log.warn({ itemId: claim.itemId, contactId: id, err: errText(err) }, "notifier: taking the claim's former phone off a HighLevel contact failed");
      }
    }
  }

  // Creates/updates the claim's contact and returns it, or throws ContactConflictError.
  // formerPhone: the phone the claim had until the board changed it.
  async function syncContact(claim: Claim, formerPhone: string | null = null): Promise<ContactIdentity> {
    const email = claim.email?.trim() || null;
    const phone = claim.phone?.trim() || null;
    if (!email && !phone) {
      throw new PermanentJobError(`Claim ${claim.claimNumber} has no email or phone for a HighLevel contact`);
    }
    const others = (list: Claim[]) => list.filter((o) => o.itemId !== claim.itemId);
    const otherEmail = (o: Claim) => !!o.email?.trim() && !sameEmail(o.email, email);
    // Upserting with a phone that another claim uses with another email would let
    // HighLevel match their contact on the phone and give it this email (the
    // takeover); with an email another claim uses with another phone, it would
    // move their texts to this phone. Then the phone is left out.
    const phoneShared = phone ? others(repo.findClaimsByPhone(phone)).filter(otherEmail) : [];
    const emailShared = email ? others(repo.findClaimsByEmail(email)).filter((o) => !!o.phone && o.phone !== phone) : [];
    const keepPhone = !!phone && !phoneShared.length && !emailShared.length;
    // Claims (other than this one) that use the contact with a different email.
    const usedByOthers = (k: ContactIdentity) => others(repo.findClaimsByContact(k.id)).filter(otherEmail);
    const before = repo.getClaim(claim.itemId)?.highlevelContactId ?? null;

    // The upsert matched, on the phone, a contact that other claims use with
    // another email (HighLevel had the number on it though no claim here does)
    // and gave it this claim's email. Put their details back, so their messages
    // and documents still reach them and the email-only upsert below finds or
    // creates this claim's own contact. Not when the contact was already this
    // claimant's: this claim's own, or one with a claim that has this email.
    async function giveBack(k: ContactIdentity): Promise<void> {
      if (!sameEmail(k.email, email) || k.id === before) return;
      const onIt = others(repo.findClaimsByContact(k.id));
      if (onIt.some((o) => sameEmail(o.email, email))) return;
      const owners = onIt.filter(otherEmail);
      if (!owners.length || new Set(owners.map((o) => o.email!.trim().toLowerCase())).size !== 1) return;
      const owner = owners[0]!;
      await highlevel.updateContact(k.id, {
        name: contactName(owner),
        firstName: firstNameOf(owner.firstName),
        email: owner.email!.trim(),
        customFields: { claim_number: owner.claimNumber, portal_url: services.tokens.portalUrl(owner) },
      });
      log.warn({ itemId: claim.itemId, contactId: k.id }, "notifier: put another claim's email back on the HighLevel contact its phone matched");
    }

    const upsert = (withPhone: boolean) =>
      highlevel.upsertContact({
        name: contactName(claim),
        firstName: firstNameOf(claim.firstName),
        email,
        phone: withPhone ? phone : null,
        smsOptIn: claim.smsOptIn,
        tags: [CLAIMANT_TAG],
        customFields: { claim_number: claim.claimNumber, portal_url: services.tokens.portalUrl(claim) },
      });

    let k: ContactIdentity | null = null;
    if (email || keepPhone) {
      k = await upsert(keepPhone);
      if (email && keepPhone && (!emailFits(claim, k) || usedByOthers(k).length)) {
        // HighLevel matched a contact on the phone that isn't this email's (or is
        // another claim's): match on the email alone, leaving the phone off.
        log.warn({ itemId: claim.itemId }, 'notifier: phone matched another HighLevel contact; matching on email only');
        await giveBack(k);
        k = await upsert(false);
      }
    }
    if (!k || !emailFits(claim, k)) {
      const involved = [...phoneShared, ...(k ? usedByOthers(k) : [])];
      await onceFor(ctx, `contact-conflict:${claim.itemId}:${keyHash(`${email}|${phone}`)}`, (once) =>
        monday.createUpdate(claim.itemId, conflictNote(claim, involved).value, once),
      );
      log.warn({ itemId: claim.itemId }, 'notifier: no HighLevel contact reaches only this claim; nothing sent');
      if (formerPhone) await dropFormerPhone(claim, formerPhone, [before]);
      throw new ContactConflictError(
        `Claim ${claim.claimNumber}: no HighLevel contact matches only this claim's ${email ? 'email' : 'phone'}; not sending (the team was told on the item)`,
      );
    }
    if (email && usedByOthers(k).length) {
      // Its email is this claim's, so this claim may use it; the other claim's
      // stored id is stale and is re-checked before its next send.
      log.warn({ itemId: claim.itemId, contactId: k.id }, 'notifier: HighLevel contact is also stored for a claim with another email');
    }
    if (smsAllowed(claim) && !smsFits(claim, k)) {
      // Informational: don't hold up the email for it.
      await onceFor(ctx, `contact-sms-off:${claim.itemId}:${keyHash(`${k.id}|${phone}`)}`, (once) =>
        monday.createUpdate(claim.itemId, smsOffNote(phoneShared, emailShared).value, once),
      ).catch((err) => log.warn({ itemId: claim.itemId, err: errText(err) }, 'notifier: posting the texts-off note failed'));
    }
    repo.setHighlevelContact(claim.itemId, k.id);
    if (before && before !== k.id) await noteSettlementLeftBehind(claim.itemId, before);
    if (formerPhone) await dropFormerPhone(claim, formerPhone, [k.id, before]);
    return k;
  }

  const ensureContact = async (claim: Claim, opts: { formerPhone?: string | null } = {}): Promise<string> =>
    (await syncContact(current(claim), opts.formerPhone ?? null)).id;

  // The claim's contact, re-read from HighLevel right before a send: the stored
  // id is used only while the contact still has the claim's email (and, to text,
  // its phone; a claim without an email, only its phone). Otherwise the contact
  // is synced again, which refuses rather than send to someone else.
  async function contactFor(c: Claim, texting: boolean): Promise<ContactIdentity> {
    const k = c.highlevelContactId ? await highlevel.getContact(c.highlevelContactId) : null;
    if (k && (emailFits(c, k) || (texting && textFits(c, k))) && (!texting || smsFits(c, k))) return k;
    return syncContact(c);
  }

  async function sendSms(claim: Claim, text: string): Promise<boolean> {
    const c = current(claim);
    const message = text.trim();
    if (!message || !smsAllowed(c)) return false;
    const contact = await contactFor(c, true);
    if (!smsFits(c, contact)) {
      log.warn({ itemId: c.itemId, channel: 'sms' }, 'claimant SMS not sent: the HighLevel contact has another phone');
      return false;
    }
    await highlevel.sendSms({ contactId: contact.id, message });
    log.info({ itemId: c.itemId, channel: 'sms' }, 'claimant SMS sent');
    return true;
  }

  // emailSent / smsSent report whether the claimant has that channel's message
  // for this event, whether it went out in this call or an earlier attempt.
  async function notify(
    claim: Claim,
    key: TemplateKey,
    extra: Partial<TemplateVars> = {},
    opts: { eventKey?: string } = {},
  ): Promise<NotifyResult> {
    const c = current(claim);
    const t = services.templates.get(key);
    const emailKey = opts.eventKey ? `sent:${opts.eventKey}:email` : null;
    const smsKey = opts.eventKey ? `sent:${opts.eventKey}:sms` : null;

    const wantEmail = !!c.email?.trim() && !!t.emailSubject.trim() && !!t.emailBody.trim();
    const wantSms = !EMAIL_ONLY_TEMPLATE_KEYS.has(key) && !!t.sms.trim() && smsAllowed(c);
    const doEmail = wantEmail && !(emailKey && repo.isEventProcessed(emailKey));
    const doSms = wantSms && !(smsKey && repo.isEventProcessed(smsKey));
    const result: NotifyResult = { emailSent: wantEmail && !doEmail, smsSent: wantSms && !doSms };
    if (!doEmail && !doSms) return result;

    // Has the claim's email (contactFor guarantees it or throws).
    const contact = await contactFor(c, doSms);
    const contactId = contact.id;
    const vars = services.templates.vars(c, extra);
    // The name is the claimant's own text: it never carries a link into a message.
    vars.firstName = firstNameOf(vars.firstName) || 'there';
    vars.claimantName = cleanName(vars.claimantName);

    if (doEmail) {
      // Settlement amounts belong on the claim page and the document only.
      const v: TemplateVars = { ...vars, settlementAmount: '' };
      const subject = services.templates.render(t.emailSubject, v).replace(/\s+/g, ' ').trim();
      const buttons: EmailButton[] = NO_CLAIM_LINK_TEMPLATE_KEYS.has(key) ? [] : [{ url: v.portalUrl, label: 'View your claim' }];
      if (v.paymentFormUrl) buttons.push({ url: v.paymentFormUrl, label: 'Choose how to be paid' });
      const content = { subject, bodyText: services.templates.render(t.emailBody, v), claimNumber: c.claimNumber, buttons, linkPrefixes, logoUrl };
      // A failure here propagates so the job retries; channels already sent are skipped then.
      await highlevel.sendEmail({ contactId, subject, html: renderEmailHtml(content), text: renderEmailText(content) });
      if (emailKey) repo.markEventProcessed(emailKey);
      result.emailSent = true;
    }

    if (doSms && !smsFits(c, contact)) {
      // The phone is on another contact (the team was told when it was synced).
      log.warn({ itemId: c.itemId, key }, 'claimant SMS not sent: the HighLevel contact has another phone');
    } else if (doSms) {
      const message = services.templates.render(t.sms, { ...vars, amountClaimed: '', settlementAmount: '' }).trim();
      if (message) {
        try {
          await highlevel.sendSms({ contactId, message });
          if (smsKey) repo.markEventProcessed(smsKey);
          result.smsSent = true;
        } catch (err) {
          // SMS is the only channel: let the job retry. Otherwise the email carried
          // the message, and SMS failures (carrier blocks, DND) rarely clear on retry.
          if (!wantEmail) throw err;
          log.warn({ itemId: c.itemId, key, err: errText(err) }, 'claimant SMS failed; email was delivered');
        }
      }
    }

    log.info({ itemId: c.itemId, key, email: result.emailSent, sms: result.smsSent }, 'claimant notified');
    return result;
  }

  return { notify, sendSms, ensureContact };
}
