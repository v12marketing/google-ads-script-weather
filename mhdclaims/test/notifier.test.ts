import { describe, expect, it, vi } from 'vitest';
import { FakeHighLevel } from '../src/adapters/highlevel/fake.js';
import { FakeMonday } from '../src/adapters/monday/fake.js';
import { buildContext } from '../src/context.js';
import { openDb } from '../src/db/index.js';
import type { NewClaim } from '../src/db/repo.js';
import type { Claim } from '../src/domain/types.js';
import type { AppContext } from '../src/services/contracts.js';
import { PermanentJobError } from '../src/services/jobs.js';
import { MemoryFileStore } from '../src/services/storage.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let seq = 7000;
function makeClaim(ctx: AppContext, o: Partial<NewClaim> = {}): Claim {
  const { tokens } = ctx.services;
  return ctx.repo.createClaim(
    {
      itemId: String(seq++),
      claimantName: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      statusKey: 'received',
      statusLabel: 'New',
      amountClaimed: 1250,
      receivedAt: '2026-10-22T14:00:00.000Z',
      ...o,
    },
    (id, v) => tokens.tokenHash(tokens.portalToken(id, v)),
  ).claim;
}

const setup = (config: Parameters<typeof makeTestEnv>[0] = {}): TestEnv & { notifier: AppContext['services']['notifier'] } => {
  const env = makeTestEnv(config);
  return { ...env, notifier: env.ctx.services.notifier };
};

describe('notify', () => {
  it('sends the confirmation by email and SMS and records the HighLevel contact', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    const portalUrl = ctx.services.tokens.portalUrl(claim);

    const res = await notifier.notify(claim, 'confirmation');

    expect(res).toEqual({ emailSent: true, smsSent: true });
    const contactId = ctx.repo.getClaim(claim.itemId)!.highlevelContactId;
    expect(contactId).toBeTruthy();
    expect(highlevel.contacts.get(contactId!)).toMatchObject({
      name: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      tags: ['hdc-claimant'],
      customFields: { claim_number: claim.claimNumber, portal_url: portalUrl },
    });

    expect(highlevel.emails).toHaveLength(1);
    const mail = highlevel.emails[0]!;
    expect(mail.contactId).toBe(contactId);
    expect(mail.subject).toBe(`We've received your claim (${claim.claimNumber})`);
    expect(mail.html).toContain(claim.claimNumber);
    expect(mail.html).toContain('October 22, 2026');
    expect(mail.html).toMatch(/>View your claim<\/a>/);
    expect(mail.html).toContain(`href="${portalUrl}"`);
    expect(mail.text).toContain('Hi Jane,');
    expect(mail.text).toContain(portalUrl);

    expect(highlevel.sms).toHaveLength(1);
    expect(highlevel.sms[0]!.message).toBe(
      `Home Delivery Claims: We received your claim ${claim.claimNumber}. Track it, message us or add photos here: ${portalUrl} Reply STOP to opt out, HELP for help.`,
    );
  });

  it('reuses the stored contact instead of upserting again', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    await notifier.notify(claim, 'confirmation');
    // Stale copy without the contact id: the notifier re-reads it.
    await notifier.notify(claim, 'under_review');
    expect(highlevel.calls.filter((c) => c.method === 'upsertContact')).toHaveLength(1);
    expect(highlevel.emails).toHaveLength(2);
  });

  it.each([
    ['SMS is disabled', { config: { SMS_ENABLED: false } }, {}],
    ['the claimant did not opt in', {}, { smsOptIn: false }],
    ['there is no phone', {}, { phone: null }],
  ] as const)('sends email only when %s', async (_label, cfg, claimOverrides) => {
    const { ctx, highlevel, notifier } = setup(cfg);
    const claim = makeClaim(ctx, claimOverrides);
    expect(await notifier.notify(claim, 'under_review')).toEqual({ emailSent: true, smsSent: false });
    expect(highlevel.emails).toHaveLength(1);
    expect(highlevel.sms).toHaveLength(0);
  });

  it('honors an opt-out recorded after the caller loaded the claim', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    ctx.repo.updateClaim(claim.itemId, { smsOptedOut: true });
    expect(await notifier.notify(claim, 'under_review')).toEqual({ emailSent: true, smsSent: false });
    expect(highlevel.sms).toHaveLength(0);
  });

  it('texts a claimant who has no email', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx, { email: null });
    expect(await notifier.notify(claim, 'more_info_needed')).toEqual({ emailSent: false, smsSent: true });
    expect(highlevel.emails).toHaveLength(0);
    expect(highlevel.sms).toHaveLength(1);
  });

  it('does nothing for a claim with no way to reach the claimant', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx, { email: null, phone: null });
    expect(await notifier.notify(claim, 'under_review')).toEqual({ emailSent: false, smsSent: false });
    expect(highlevel.calls).toHaveLength(0);
    await expect(notifier.ensureContact(claim)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('sends the STATUS reply by SMS only', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx, { statusLabel: 'Under review' });
    expect(await notifier.notify(claim, 'status_reply')).toEqual({ emailSent: false, smsSent: true });
    expect(highlevel.emails).toHaveLength(0);
    expect(highlevel.sms[0]!.message).toBe(
      `Home Delivery Claims: Claim ${claim.claimNumber}: Under review. Details: ${ctx.services.tokens.portalUrl(claim)}`,
    );
  });

  it('never texts a login code, even if a stored template has SMS text', async () => {
    const { ctx, highlevel, notifier } = setup();
    ctx.repo.saveTemplate({ ...ctx.services.templates.getDefault('login_code'), sms: 'Code {{code}}' }, 'test');
    const claim = makeClaim(ctx);
    expect(await notifier.notify(claim, 'login_code', { code: '482913' })).toEqual({ emailSent: true, smsSent: false });
    expect(highlevel.sms).toHaveLength(0);
    expect(highlevel.emails[0]!.html).toContain('482913');
    expect(highlevel.emails[0]!.subject).not.toContain('482913');
  });

  it('sends the login code without the claim link or button, which would open the page where the code fails', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    await notifier.notify(claim, 'login_code', { code: '482913' });
    const mail = highlevel.emails[0]!;
    const portalUrl = ctx.services.tokens.portalUrl(claim);
    expect(mail.html).toContain('482913');
    expect(mail.html).not.toContain(portalUrl);
    expect(mail.text).not.toContain(portalUrl);
    expect(mail.html).not.toContain('View your claim');
    // Other emails keep both.
    await notifier.notify(claim, 'under_review');
    expect(highlevel.emails[1]!.html).toContain(`href="${portalUrl}"`);
    expect(highlevel.emails[1]!.html).toContain('View your claim');
  });

  it('keeps settlement amounts out of email and all amounts out of SMS, even in edited templates', async () => {
    const { ctx, highlevel, notifier } = setup();
    ctx.services.templates.save(
      {
        key: 'under_review',
        emailSubject: 'Claim {{claimNumber}} {{settlementAmount}}',
        emailBody: 'Claimed {{amountClaimed}}, offer [{{settlementAmount}}] {{portalUrl}}',
        sms: 'Claimed [{{amountClaimed}}] offer [{{settlementAmount}}]',
        portalText: 'x',
      },
      'admin',
    );
    const claim = ctx.repo.updateClaim(makeClaim(ctx).itemId, { settlementAmount: 900 })!;
    await notifier.notify(claim, 'under_review');
    const mail = highlevel.emails[0]!;
    expect(mail.subject).toBe(`Claim ${claim.claimNumber}`);
    expect(mail.text).toContain('Claimed $1,250.00, offer []');
    expect(mail.html).not.toContain('900');
    expect(highlevel.sms[0]!.message).toBe('Claimed [] offer []');
  });

  it('escapes HTML in a team or claimant message', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    await notifier.notify(claim, 'new_message', { message: '<script>alert("hi")</script> & <b>bold</b>\nhttps://evil.test/"><img src=x>' });
    const mail = highlevel.emails[0]!;
    expect(mail.html).not.toMatch(/<script|<b>|<img/);
    expect(mail.html).toContain('&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;');
    // Not our site: shown as text, never made a link.
    expect(mail.html).not.toContain('href="https://evil.test');
    expect(mail.html).toContain('https://evil.test/&quot;&gt;&lt;img src=x&gt;');
    expect(mail.text).toContain('<script>alert("hi")</script>');
    // The SMS points to the claim page rather than repeating the message.
    expect(highlevel.sms[0]!.message).not.toContain('script');
  });
});

describe('notify idempotency', () => {
  it('skips channels already sent for the event across a retry', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    await notifier.ensureContact(claim);

    highlevel.failNext = 1; // the email send fails
    await expect(notifier.notify(claim, 'under_review', {}, { eventKey: 'status:evt-1' })).rejects.toThrow(/simulated failure/);
    expect(highlevel.emails).toHaveLength(0);
    expect(highlevel.sms).toHaveLength(0);

    // The job retries.
    expect(await notifier.notify(claim, 'under_review', {}, { eventKey: 'status:evt-1' })).toEqual({ emailSent: true, smsSent: true });
    // A redelivery after success sends nothing new but reports the event delivered.
    expect(await notifier.notify(claim, 'under_review', {}, { eventKey: 'status:evt-1' })).toEqual({ emailSent: true, smsSent: true });
    expect(highlevel.emails).toHaveLength(1);
    expect(highlevel.sms).toHaveLength(1);

    // A different event (the same status set again later) is sent.
    await notifier.notify(claim, 'under_review', {}, { eventKey: 'status:evt-2' });
    expect(highlevel.emails).toHaveLength(2);
  });

  it('does not resend the email when only the SMS failed', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    vi.spyOn(highlevel, 'sendSms').mockRejectedValueOnce(new Error('carrier rejected'));

    expect(await notifier.notify(claim, 'payment_sent', {}, { eventKey: 'status:evt-3' })).toEqual({ emailSent: true, smsSent: false });
    expect(await notifier.notify(claim, 'payment_sent', {}, { eventKey: 'status:evt-3' })).toEqual({ emailSent: true, smsSent: true });
    expect(highlevel.emails).toHaveLength(1);
    expect(highlevel.sms).toHaveLength(1);
  });

  it('rethrows an SMS failure when SMS is the only channel', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx, { email: null });
    await notifier.ensureContact(claim);
    highlevel.failNext = 1;
    await expect(notifier.notify(claim, 'closed', {}, { eventKey: 'status:evt-4' })).rejects.toThrow(/simulated failure/);
    expect(await notifier.notify(claim, 'closed', {}, { eventKey: 'status:evt-4' })).toEqual({ emailSent: false, smsSent: true });
    expect(highlevel.sms).toHaveLength(1);
  });

  it('sends every time without an event key', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    await notifier.notify(claim, 'under_review');
    await notifier.notify(claim, 'under_review');
    expect(highlevel.emails).toHaveLength(2);
    expect(highlevel.sms).toHaveLength(2);
  });
});

describe('sendSms', () => {
  it('sends a one-off SMS through the claim contact', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    expect(await notifier.sendSms(claim, '  Claim status: Under review  ')).toBe(true);
    expect(highlevel.sms).toEqual([{ contactId: ctx.repo.getClaim(claim.itemId)!.highlevelContactId, message: 'Claim status: Under review' }]);
  });

  it('applies the same SMS gates', async () => {
    const off = setup({ config: { SMS_ENABLED: false } });
    expect(await off.notifier.sendSms(makeClaim(off.ctx), 'hi')).toBe(false);

    const { ctx, highlevel, notifier } = setup();
    expect(await notifier.sendSms(makeClaim(ctx, { smsOptIn: false }), 'hi')).toBe(false);
    expect(await notifier.sendSms(makeClaim(ctx, { phone: null }), 'hi')).toBe(false);
    expect(await notifier.sendSms(makeClaim(ctx), '   ')).toBe(false);
    const optedOut = makeClaim(ctx);
    ctx.repo.updateClaim(optedOut.itemId, { smsOptedOut: true });
    expect(await notifier.sendSms(optedOut, 'hi')).toBe(false);
    expect(highlevel.sms).toHaveLength(0);
  });
});

describe('ensureContact', () => {
  it('upserts with current details and stores the id', async () => {
    const { ctx, highlevel, notifier } = setup();
    const claim = makeClaim(ctx);
    const id = await notifier.ensureContact(claim);
    const updated = ctx.repo.updateClaim(claim.itemId, { email: 'jane.new@example.com', firstName: 'Janet' })!;
    expect(await notifier.ensureContact(updated)).toBe(id);
    expect(highlevel.contacts.get(id)).toMatchObject({ email: 'jane.new@example.com', firstName: 'Janet' });
    expect(ctx.repo.getClaim(claim.itemId)!.highlevelContactId).toBe(id);
  });
});

describe('logging', () => {
  it('never logs message bodies, codes, links or contact details', async () => {
    const lines: string[] = [];
    const capture = (obj: unknown, msg?: string) => void lines.push(JSON.stringify(obj) + (msg ?? ''));
    const env = makeTestEnv();
    const highlevel = new FakeHighLevel();
    const ctx = buildContext({
      config: env.config,
      board: env.board,
      monday: new FakeMonday(),
      highlevel,
      store: new MemoryFileStore(),
      log: { info: capture, warn: capture, error: capture },
      db: openDb(':memory:'),
    });
    const claim = makeClaim(ctx);
    await ctx.services.notifier.notify(claim, 'login_code', { code: '135790' });
    await ctx.services.notifier.notify(claim, 'new_message', { message: 'secret words' });
    vi.spyOn(highlevel, 'sendSms').mockRejectedValueOnce(new Error('carrier rejected'));
    await ctx.services.notifier.notify(claim, 'under_review');
    await ctx.services.notifier.sendSms(claim, 'Your status');

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    const token = ctx.services.tokens.portalToken(claim.itemId, claim.tokenVersion);
    for (const secret of ['135790', 'secret words', token, 'jane@example.com', '+16035550100', 'Your status']) {
      expect(all).not.toContain(secret);
    }
  });
});
