import { describe, expect, it, vi } from 'vitest';
import { cleanName, firstNameOf, isLinkLike } from '../src/services/claim-fields.js';
import { ContactConflictError } from '../src/services/notifier.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

// HighLevel dedupes contacts on email OR phone and delivers to the contact's own
// email and phone. Whatever claims share, a claim's codes, links and emails must
// only ever reach claim.email (and its texts claim.phone).

const VERA = { name: 'Vera Victim', email: 'vera@example.com', phone: '+16035550100' };

const updatesOn = (env: TestEnv, itemId: string) =>
  [...env.monday.updates.values()].filter((u) => u.itemId === itemId).map((u) => u.textBody);

// Where each email/text actually went: the contact's email/phone at send time.
function deliveries(env: TestEnv) {
  const hl = env.highlevel;
  const emails: Array<{ to: string | null; subject: string; text: string; html: string }> = [];
  const sms: Array<{ to: string | null; message: string }> = [];
  const sendEmail = hl.sendEmail.bind(hl);
  const sendSms = hl.sendSms.bind(hl);
  vi.spyOn(hl, 'sendEmail').mockImplementation(async (m) => {
    emails.push({ to: hl.contacts.get(m.contactId)?.email ?? null, subject: m.subject, text: m.text, html: m.html });
    return sendEmail(m);
  });
  vi.spyOn(hl, 'sendSms').mockImplementation(async (m) => {
    sms.push({ to: hl.contacts.get(m.contactId)?.phone ?? null, message: m.message });
    return sendSms(m);
  });
  return { emails, sms };
}

async function fileClaim(env: TestEnv, o: Parameters<typeof addClaimItem>[1] = {}) {
  const item = addClaimItem(env, o);
  await env.ctx.services.intake.handleItemCreated(item.id);
  return { item, claim: () => env.ctx.repo.getClaim(item.id)! };
}

const codeIn = (text: string): string => text.match(/^(\d{6})$/m)![1]!;

describe('HighLevel contact identity', () => {
  it("a claim filed with someone else's phone can't take over their contact: their codes and links reach only them", async () => {
    const env = makeTestEnv();
    const sent = deliveries(env);
    const vera = await fileClaim(env, VERA);
    const veraContact = vera.claim().highlevelContactId!;
    const mallory = await fileClaim(env, { name: 'Mallory Smith', email: 'mallory@evil.example', phone: VERA.phone });

    // Vera's contact keeps her email; the new claim gets a contact of its own, without the phone.
    expect(env.highlevel.contacts.get(veraContact)).toMatchObject({ email: VERA.email, phone: VERA.phone });
    const malloryContact = mallory.claim().highlevelContactId!;
    expect(malloryContact).not.toBe(veraContact);
    expect(env.highlevel.contacts.get(malloryContact)).toMatchObject({ email: 'mallory@evil.example', phone: null });

    // "Find my claim" for Vera's address, and a code on Vera's claim page.
    const { auth, tokens } = env.ctx.services;
    await auth.sendClaimLinks(VERA.email);
    await vi.waitFor(() => expect(sent.emails.some((e) => e.subject === 'Your claim links from Home Delivery Claims')).toBe(true));
    const device = auth.newDeviceId();
    expect(await auth.sendLoginCode(vera.claim(), device)).toEqual({ sent: true, maskedEmail: 'v***@e***.com' });

    const veraLink = tokens.portalUrl(vera.claim());
    const withVeraLink = sent.emails.filter((e) => e.text.includes(veraLink));
    expect(withVeraLink.length).toBe(2); // confirmation, claim links (the code email has no link)
    for (const e of withVeraLink) expect(e.to).toBe(VERA.email);
    expect(sent.emails.at(-1)!.subject).toContain('sign-in code');
    expect(sent.emails.at(-1)!.to).toBe(VERA.email);
    expect(sent.emails.filter((e) => e.to !== VERA.email).every((e) => !e.text.includes(veraLink))).toBe(true);
    expect(auth.verifyLoginCode(vera.claim(), device, codeIn(sent.emails.at(-1)!.text))).toBe('ok');

    // Texts for the new claim would reach Vera's phone: they are off, and the team is told once.
    expect(sent.sms.filter((s) => s.message.includes(mallory.claim().claimNumber))).toEqual([]);
    expect(sent.sms.filter((s) => s.message.includes(vera.claim().claimNumber)).map((s) => s.to)).toEqual([VERA.phone]);
    const notes = updatesOn(env, mallory.item.id).filter((u) => u.startsWith('Texts are off'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(vera.claim().claimNumber);
  });

  it("a claim filed with someone else's email can't move their texts to another phone", async () => {
    const env = makeTestEnv();
    const sent = deliveries(env);
    const vera = await fileClaim(env, VERA);
    const veraContact = vera.claim().highlevelContactId!;
    const other = await fileClaim(env, { name: 'Mallory Smith', email: VERA.email, phone: '+16035550199' });

    expect(env.highlevel.contacts.get(veraContact)).toMatchObject({ email: VERA.email, phone: VERA.phone });
    const { notifier } = env.ctx.services;
    await notifier.notify(vera.claim(), 'under_review');
    await notifier.notify(other.claim(), 'under_review');
    expect(await notifier.sendSms(other.claim(), 'Your status')).toBe(false);
    // Every text went to Vera's own phone, and only about her claim.
    expect(sent.sms.map((s) => s.to)).toEqual([VERA.phone, VERA.phone]);
    expect(sent.sms.every((s) => !s.message.includes(other.claim().claimNumber))).toBe(true);
    expect(updatesOn(env, other.item.id).filter((u) => u.startsWith('Texts are off'))).toHaveLength(1);
  });

  it('matches on the email alone when HighLevel matched the phone to a contact with another email', async () => {
    const env = makeTestEnv();
    env.highlevel.matchOrder = ['phone', 'email'];
    // Contacts the integration didn't create: one with the claimant's email, one with their phone.
    const byEmail = await env.highlevel.upsertContact({ name: 'Jane', firstName: 'Jane', email: 'jane@example.com', phone: null, smsOptIn: false });
    const byPhone = await env.highlevel.upsertContact({ name: 'Pat', firstName: 'Pat', email: 'pat@example.com', phone: '+16035550100', smsOptIn: false });
    const sent = deliveries(env);

    const jane = await fileClaim(env);
    expect(jane.claim().highlevelContactId).toBe(byEmail.id);
    expect(env.highlevel.contacts.get(byPhone.id)!.email).toBe('pat@example.com');
    expect(sent.emails.map((e) => e.to)).toEqual(['jane@example.com']);
    // The phone is Pat's contact's, so no text.
    expect(sent.sms).toEqual([]);
    expect(updatesOn(env, jane.item.id).filter((u) => u.startsWith('Texts are off'))).toHaveLength(1);
  });

  it('a corrected email reaches HighLevel, and browsers verified through the old address must verify again', async () => {
    const env = makeTestEnv();
    const sent = deliveries(env);
    const jane = await fileClaim(env, { email: 'jane@gmial.com' });
    const { auth, intake } = env.ctx.services;
    const device = auth.newDeviceId();
    await auth.sendLoginCode(jane.claim(), device);
    expect(sent.emails.at(-1)!.to).toBe('jane@gmial.com');
    expect(auth.verifyLoginCode(jane.claim(), device, codeIn(sent.emails.at(-1)!.text))).toBe('ok');

    env.monday.setText(jane.item.id, env.board.columns.email, 'jane@gmail.com', 'email');
    const claim = (await intake.refreshClaim(jane.item.id))!;
    expect(claim.email).toBe('jane@gmail.com');
    expect(env.highlevel.contacts.get(claim.highlevelContactId!)!.email).toBe('jane@gmail.com');
    expect(auth.isDeviceTrusted(claim, device)).toBe(false);

    expect((await auth.sendLoginCode(claim, auth.newDeviceId())).sent).toBe(true);
    expect(sent.emails.at(-1)!.to).toBe('jane@gmail.com');
  });

  it('a corrected phone reaches HighLevel without forgetting trusted browsers', async () => {
    const env = makeTestEnv();
    const sent = deliveries(env);
    const jane = await fileClaim(env);
    const { auth, intake, notifier } = env.ctx.services;
    const device = auth.newDeviceId();
    await auth.sendLoginCode(jane.claim(), device);
    expect(auth.verifyLoginCode(jane.claim(), device, codeIn(sent.emails.at(-1)!.text))).toBe('ok');

    env.monday.setText(jane.item.id, env.board.columns.phone, '+16035550177', 'phone');
    const claim = (await intake.refreshClaim(jane.item.id))!;
    expect(env.highlevel.contacts.get(claim.highlevelContactId!)!.phone).toBe('+16035550177');
    expect(auth.isDeviceTrusted(claim, device)).toBe(true);
    await notifier.notify(claim, 'under_review');
    expect(sent.sms.at(-1)!.to).toBe('+16035550177');
  });

  it("re-checks the contact before every send, so one changed in HighLevel doesn't get the claim's email", async () => {
    const env = makeTestEnv();
    const sent = deliveries(env);
    const jane = await fileClaim(env);
    env.highlevel.contacts.get(jane.claim().highlevelContactId!)!.email = 'someone@else.example';

    await env.ctx.services.notifier.notify(jane.claim(), 'under_review');
    expect(sent.emails.at(-1)!.to).toBe('jane@example.com');
  });

  it("sends nothing when HighLevel won't give a contact with the claim's email, and tells the team once", async () => {
    const env = makeTestEnv();
    const sent = deliveries(env);
    const jane = await fileClaim(env);
    const before = sent.emails.length;
    env.highlevel.contacts.get(jane.claim().highlevelContactId!)!.email = 'someone@else.example';
    vi.spyOn(env.highlevel, 'upsertContact').mockResolvedValue({ id: 'contact_x', email: 'someone@else.example', phone: null });

    const { auth, notifier } = env.ctx.services;
    await expect(auth.sendLoginCode(jane.claim(), auth.newDeviceId())).rejects.toBeInstanceOf(ContactConflictError);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()).toEqual({ n: 0 });
    await expect(notifier.notify(jane.claim(), 'under_review')).rejects.toBeInstanceOf(ContactConflictError);
    expect(sent.emails).toHaveLength(before);
    expect(sent.sms.filter((s) => s.message.includes('Under review'))).toEqual([]);
    expect(jane.claim().highlevelContactId).not.toBe('contact_x');
    expect(updatesOn(env, jane.item.id).filter((u) => u.startsWith('Emails and texts to the claimant are on hold'))).toHaveLength(1);
  });

  it("a claim with only a phone never uses another claimant's contact, which has their email", async () => {
    const env = makeTestEnv();
    const sent = deliveries(env);
    const vera = await fileClaim(env, VERA);
    const c = env.board.columns;
    const walkIn = env.monday.addItem(env.board.claimsBoardId, 'Walk In', {
      [c.phone]: { type: 'phone', text: VERA.phone },
      [c.smsOptIn]: { type: 'checkbox', text: 'v', value: '{"checked":"true"}' },
      [c.status]: { type: 'status', text: 'New' },
    });
    await expect(env.ctx.services.intake.handleItemCreated(walkIn.id)).resolves.toBeUndefined();

    const claim = env.ctx.repo.getClaim(walkIn.id)!;
    expect(claim.highlevelContactId).toBeNull();
    expect(env.highlevel.contacts.get(vera.claim().highlevelContactId!)).toMatchObject({ name: 'Vera Victim', email: VERA.email });
    expect(sent.sms.filter((s) => s.message.includes(claim.claimNumber))).toEqual([]);
    expect(updatesOn(env, walkIn.id).filter((u) => u.startsWith('Texts to the claimant are on hold'))).toHaveLength(1);
  });
});

describe('claimant names in emails', () => {
  it('drops link-like words from names', () => {
    for (const w of ['https://evil.example/x', 'www.evil.example', 'evil.com', 'jane@example.com', 'a/b', '<b>']) expect(isLinkLike(w)).toBe(true);
    for (const w of ['Jane', "O'Brien", 'Mary-Ann', 'J.R.', 'José']) expect(isLinkLike(w)).toBe(false);
    expect(firstNameOf('https://evil.example/verify Smith')).toBe('');
    expect(firstNameOf('evil.com')).toBe('');
    expect(firstNameOf('Jane Doe')).toBe('Jane');
    expect(firstNameOf('A'.repeat(41))).toBe('');
    expect(cleanName('Jane https://evil.example/x Doe')).toBe('Jane Doe');
  });

  it("never makes a URL typed as the claimant's name a link, or puts it in the email", async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env, { name: 'https://homedeliveryclaims-payments.example/verify Smith', email: 'victim@example.com' });
    await env.ctx.services.intake.handleItemCreated(item.id);

    const mail = env.highlevel.emails[0]!;
    expect(mail.text).toContain('Hi there,');
    expect(mail.text).not.toContain('homedeliveryclaims-payments');
    expect(mail.html).not.toContain('homedeliveryclaims-payments');
    expect(mail.html).toMatch(/href="https:\/\/claims\.test\/c\//);
    const claim = env.ctx.repo.getClaim(item.id)!;
    expect(env.highlevel.contacts.get(claim.highlevelContactId!)).toMatchObject({ name: 'Smith', firstName: '' });
  });

  it('only links our own site and the payment form, even in a stored claim with a link for a name', async () => {
    const env = makeTestEnv();
    const jane = await fileClaim(env);
    env.ctx.repo.updateClaim(jane.item.id, { firstName: 'https://evil.example/x', claimantName: 'https://evil.example/x Doe' });
    await env.ctx.services.notifier.notify(jane.claim(), 'new_message', {
      message: `See https://evil.example/pay or ${env.ctx.services.payment.paymentFormUrl(jane.claim())}`,
    });
    const mail = env.highlevel.emails.at(-1)!;
    expect(mail.text).toContain('Hi there,');
    expect(mail.html).not.toMatch(/href="https:\/\/evil\.example/);
    expect(mail.html).toContain('See https://evil.example/pay or <a href="https://forms.monday.com/forms/paymentform?');
  });
});

describe('intake resumes', () => {
  it('finishes an intake that failed inside a status job when the job retries', async () => {
    const env = makeTestEnv();
    // No create_item delivery: the first event for the item is a status change.
    const item = addClaimItem(env, { status: 'Under review' });
    const original = env.monday.changeColumnValues.bind(env.monday);
    let fail = true;
    vi.spyOn(env.monday, 'changeColumnValues').mockImplementation(async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('Monday down');
      }
      return original(...args);
    });
    const { status } = env.ctx.services;
    await expect(status.handleStatusChanged(item.id, 'Under review', 'evt-1')).rejects.toThrow('Monday down');
    await status.handleStatusChanged(item.id, 'Under review', 'evt-1');

    expect(env.monday.items.get(item.id)!.columnValues[env.board.columns.claimNumber]!.text).toBe('HDC-000001');
    expect(env.highlevel.emails.map((e) => e.subject)).toEqual([
      "We've received your claim (HDC-000001)",
      expect.stringContaining('HDC-000001'),
    ]);
    // Done now: another event writes and sends nothing more for intake.
    await env.ctx.services.intake.refreshClaim(item.id);
    expect(env.highlevel.emails).toHaveLength(2);
  });

  it("a refresh while intake waits for contact details doesn't tell the team early", async () => {
    const env = makeTestEnv();
    const item = env.monday.addItem(env.board.claimsBoardId, 'Walk-in Claimant', {});
    await env.ctx.services.intake.handleItemCreated(item.id);
    await env.ctx.services.intake.refreshClaim(item.id);
    await env.ctx.services.intake.refreshClaim(item.id);
    expect(updatesOn(env, item.id)).toEqual([]);

    // The re-check job tells the team.
    await env.ctx.services.intake.handleItemCreated(item.id);
    expect(updatesOn(env, item.id)).toEqual(['No email or phone on this claim — claimant was not notified.']);
  });
});
