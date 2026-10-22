import type { Claim, TemplateKey, TemplateVars } from '../domain/types.js';
import type { CoreContext, Notifier, NotifyResult, Services } from './contracts.js';
import { renderEmailHtml, renderEmailText, type EmailButton } from './email-html.js';
import { PermanentJobError } from './jobs.js';
import { EMAIL_ONLY_TEMPLATE_KEYS } from './templates.js';

// Sends claimant email/SMS through HighLevel. Never logs message bodies, codes,
// links or contact details: only the item id, template key and what was sent.

export const CLAIMANT_TAG = 'hdc-claimant';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

export function createNotifier(ctx: CoreContext, services: Services): Notifier {
  const { repo, highlevel, config, log } = ctx;


  const smsAllowed = (c: Claim): boolean => config.SMS_ENABLED && c.smsOptIn && !c.smsOptedOut && !!c.phone?.trim();

  // The caller's copy may predate a STOP reply or an earlier attempt's contact upsert.
  const current = (claim: Claim): Claim => {
    const fresh = repo.getClaim(claim.itemId);
    return fresh ? { ...claim, smsOptedOut: fresh.smsOptedOut, highlevelContactId: fresh.highlevelContactId } : claim;
  };

  async function ensureContact(claim: Claim): Promise<string> {
    if (!claim.email?.trim() && !claim.phone?.trim()) {
      throw new PermanentJobError(`Claim ${claim.claimNumber} has no email or phone for a HighLevel contact`);
    }
    const id = await highlevel.upsertContact({
      name: claim.claimantName.trim() || claim.firstName.trim() || claim.claimNumber,
      firstName: claim.firstName.trim(),
      email: claim.email?.trim() || null,
      phone: claim.phone?.trim() || null,
      smsOptIn: claim.smsOptIn,
      tags: [CLAIMANT_TAG],
      customFields: { claim_number: claim.claimNumber, portal_url: services.tokens.portalUrl(claim) },
    });
    if (repo.getClaim(claim.itemId)?.highlevelContactId !== id) repo.updateClaim(claim.itemId, { highlevelContactId: id });
    return id;
  }

  const contactFor = async (c: Claim): Promise<string> => c.highlevelContactId ?? ensureContact(c);

  async function sendSms(claim: Claim, text: string): Promise<boolean> {
    const c = current(claim);
    const message = text.trim();
    if (!message || !smsAllowed(c)) return false;
    await highlevel.sendSms({ contactId: await contactFor(c), message });
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

    const contactId = await contactFor(c);
    const vars = services.templates.vars(c, extra);

    if (doEmail) {
      // Settlement amounts belong on the claim page and the document only.
      const v: TemplateVars = { ...vars, settlementAmount: '' };
      const subject = services.templates.render(t.emailSubject, v).replace(/\s+/g, ' ').trim();
      const buttons: EmailButton[] = [{ url: v.portalUrl, label: 'View your claim' }];
      if (v.paymentFormUrl) buttons.push({ url: v.paymentFormUrl, label: 'Choose how to be paid' });
      const content = { subject, bodyText: services.templates.render(t.emailBody, v), claimNumber: c.claimNumber, buttons };
      // A failure here propagates so the job retries; channels already sent are skipped then.
      await highlevel.sendEmail({ contactId, subject, html: renderEmailHtml(content), text: renderEmailText(content) });
      if (emailKey) repo.markEventProcessed(emailKey);
      result.emailSent = true;
    }

    if (doSms) {
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
