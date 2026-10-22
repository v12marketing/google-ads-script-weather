import { describe, expect, it, vi } from 'vitest';
import type { NewClaim } from '../src/db/repo.js';
import type { Claim } from '../src/domain/types.js';
import { JOB } from '../src/services/contracts.js';
import { stripEmailReply } from '../src/services/email-reply.js';
import { ClaimantInputError, claimantMessageBody, MAX_MESSAGE_CHARS } from '../src/services/messaging.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

const CONTACT = 'contact_abc';

function makeClaim(env: TestEnv, o: Partial<NewClaim> & { contactId?: string | null } = {}): Claim {
  const { tokens } = env.ctx.services;
  const { contactId = CONTACT, ...rest } = o;
  const item = addClaimItem(env);
  const { claim } = env.ctx.repo.createClaim(
    {
      itemId: item.id,
      claimantName: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      statusKey: 'received',
      statusLabel: 'New',
      amountClaimed: 1250,
      receivedAt: '2026-10-22T14:00:00.000Z',
      ...rest,
    },
    (id, v) => tokens.tokenHash(tokens.portalToken(id, v)),
  );
  return env.ctx.repo.updateClaim(claim.itemId, { highlevelContactId: contactId })!;
}

const updateEvent = (env: TestEnv, itemId: string, updateId: string, textBody: string, creatorId: string | null = '111') => ({
  kind: 'update_created' as const,
  boardId: env.board.claimsBoardId,
  itemId,
  updateId,
  textBody,
  creatorId,
  triggerUuid: null,
});

const inbound = (body: string, o: { channel?: 'sms' | 'email'; messageId?: string | null; contactId?: string } = {}) => ({
  kind: 'inbound_message' as const,
  contactId: o.contactId ?? CONTACT,
  channel: o.channel ?? 'sms',
  body,
  messageId: o.messageId === undefined ? `hl_${Math.random().toString(36).slice(2)}` : o.messageId,
  subject: null,
});

describe('claimantMessageBody', () => {
  const prefix = 'To claimant:';

  it('matches the prefix case-insensitively after trimming, with optional space after the colon', () => {
    expect(claimantMessageBody('To claimant: Hello', prefix)).toBe('Hello');
    expect(claimantMessageBody('  to CLAIMANT:Hello there  ', prefix)).toBe('Hello there');
    expect(claimantMessageBody('To  claimant:\n\nLine one\nLine two', prefix)).toBe('Line one\nLine two');
  });

  it('ignores updates without the prefix at the start, or with nothing after it', () => {
    expect(claimantMessageBody('Internal note. To claimant: hi', prefix)).toBeNull();
    expect(claimantMessageBody('Claimant called, see notes', prefix)).toBeNull();
    expect(claimantMessageBody('To claimant:   ', prefix)).toBeNull();
    expect(claimantMessageBody('', prefix)).toBeNull();
  });

  it('respects a word boundary for prefixes without a colon', () => {
    expect(claimantMessageBody('@client hi', '@client')).toBe('hi');
    expect(claimantMessageBody('@clientele hi', '@client')).toBeNull();
  });
});

describe('handleMondayUpdate', () => {
  it('stores a prefixed team update and sends it to the claimant', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const u = env.monday.addTeamUpdate(claim.itemId, 'To claimant: Your <replacement> is on its way.');

    await env.ctx.services.messaging.handleMondayUpdate(updateEvent(env, claim.itemId, u.id, u.textBody));

    const msgs = env.ctx.repo.listMessages(claim.itemId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'to_claimant', channel: 'monday', body: 'Your <replacement> is on its way.', mondayUpdateId: u.id });
    expect(env.highlevel.emails).toHaveLength(1);
    expect(env.highlevel.emails[0]!.text).toContain('Your <replacement> is on its way.');
    expect(env.highlevel.emails[0]!.html).toContain('Your &lt;replacement&gt; is on its way.');
    expect(env.highlevel.sms).toHaveLength(1);
  });

  it('never stores or sends updates without the prefix', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const u = env.monday.addTeamUpdate(claim.itemId, 'Spoke to the carrier, waiting on their report.');

    await env.ctx.services.messaging.handleMondayUpdate(updateEvent(env, claim.itemId, u.id, u.textBody));

    expect(env.ctx.repo.listMessages(claim.itemId)).toEqual([]);
    expect(env.highlevel.emails).toHaveLength(0);
  });

  it('ignores updates by the integration user and updates whose author is unknown', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const ours = env.monday.addTeamUpdate(claim.itemId, 'To claimant: echo', env.config.MONDAY_INTEGRATION_USER_ID);
    await env.ctx.services.messaging.handleMondayUpdate(updateEvent(env, claim.itemId, ours.id, ours.textBody, ours.creatorId));

    // No creator in the webhook and none on the fetched update.
    const anon = env.monday.addTeamUpdate(claim.itemId, 'To claimant: who wrote this?');
    anon.creatorId = null;
    await env.ctx.services.messaging.handleMondayUpdate(updateEvent(env, claim.itemId, anon.id, anon.textBody, null));

    expect(env.ctx.repo.listMessages(claim.itemId)).toEqual([]);
    expect(env.highlevel.emails).toHaveLength(0);
  });

  it('fetches the update when the webhook has no text or creator', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const u = env.monday.addTeamUpdate(claim.itemId, 'To claimant: Fetched text');

    await env.ctx.services.messaging.handleMondayUpdate(updateEvent(env, claim.itemId, u.id, '', null));

    expect(env.monday.callsTo('getUpdate')).toEqual([[u.id]]);
    expect(env.ctx.repo.listMessages(claim.itemId)[0]?.body).toBe('Fetched text');
    expect(env.highlevel.emails).toHaveLength(1);
  });

  it('dedupes redeliveries and finishes sending after a failed attempt', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const u = env.monday.addTeamUpdate(claim.itemId, 'To claimant: Please send a photo of the label.');
    const ev = updateEvent(env, claim.itemId, u.id, u.textBody);
    const { messaging } = env.ctx.services;

    env.highlevel.failNext = 1; // the email send fails; the job would retry
    await expect(messaging.handleMondayUpdate(ev)).rejects.toThrow();
    expect(env.ctx.repo.listMessages(claim.itemId)).toHaveLength(1);
    expect(env.highlevel.emails).toHaveLength(0);

    await messaging.handleMondayUpdate(ev);
    await messaging.handleMondayUpdate(ev);

    expect(env.ctx.repo.listMessages(claim.itemId)).toHaveLength(1);
    expect(env.highlevel.emails).toHaveLength(1);
    expect(env.highlevel.sms).toHaveLength(1);
  });

  it('ignores updates on items that are not claims', async () => {
    const env = makeTestEnv();
    const other = env.monday.addItem(env.board.claimsBoardId, 'Not a claim');
    const u = env.monday.addTeamUpdate(other.id, 'To claimant: hello');

    await env.ctx.services.messaging.handleMondayUpdate(updateEvent(env, other.id, u.id, u.textBody));

    expect(env.ctx.repo.listMessages(other.id)).toEqual([]);
    expect(env.highlevel.emails).toHaveLength(0);
  });
});

describe('postFromPortal / deliverPortalMessage', () => {
  it('validates the text with a ClaimantInputError', () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { messaging } = env.ctx.services;

    for (const bad of ['', '   \n  ']) {
      expect(() => messaging.postFromPortal(claim, bad)).toThrow(ClaimantInputError);
    }
    try {
      messaging.postFromPortal(claim, 'x'.repeat(MAX_MESSAGE_CHARS + 1));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimantInputError);
      expect((err as ClaimantInputError).code).toBe('message_too_long');
      expect((err as Error).message).toMatch(/5,000 characters/);
    }
    expect(env.ctx.repo.listMessages(claim.itemId)).toEqual([]);
    expect(messaging.postFromPortal(claim, 'y'.repeat(MAX_MESSAGE_CHARS)).body).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it('stores the message at once, then posts it to Monday and notifies the team', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { messaging } = env.ctx.services;

    const m = messaging.postFromPortal(claim, '  The box was <b>crushed</b>.\r\n\r\nPhotos to follow & more.  ');
    expect(m).toMatchObject({ direction: 'from_claimant', channel: 'portal', body: 'The box was <b>crushed</b>.\n\nPhotos to follow & more.', mondayUpdateId: null });
    const job = env.ctx.jobs.list().find((j) => j.type === JOB.portalMessageToMonday);
    expect(job).toMatchObject({ dedupe_key: `claimant-msg:${m.id}`, status: 'pending' });
    expect(JSON.parse(job!.payload)).toEqual({ messageId: m.id });

    await env.ctx.jobs.drain();

    const posts = env.monday.callsTo('createUpdate');
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(claim.itemId);
    expect(posts[0]![1]).toBe(
      '<p><strong>From claimant (claim page):</strong></p>\n<p>The box was &lt;b&gt;crushed&lt;/b&gt;.</p>\n<p>Photos to follow &amp; more.</p>',
    );
    const stored = env.ctx.repo.getMessage(m.id)!;
    expect(stored.mondayUpdateId).toBeTruthy();
    expect(env.monday.notifications).toEqual([
      { userId: '111', itemId: claim.itemId, text: `${claim.claimNumber}: new message from the claimant` },
      { userId: '222', itemId: claim.itemId, text: `${claim.claimNumber}: new message from the claimant` },
    ]);

    // Running the job again changes nothing.
    await messaging.deliverPortalMessage(m.id);
    expect(env.monday.callsTo('createUpdate')).toHaveLength(1);
    expect(env.monday.notifications).toHaveLength(2);

    // Monday's webhook for our own update never echoes to the claimant.
    const u = env.monday.updates.get(stored.mondayUpdateId!)!;
    await messaging.handleMondayUpdate(updateEvent(env, claim.itemId, u.id, u.textBody, u.creatorId));
    await messaging.handleMondayUpdate(updateEvent(env, claim.itemId, u.id, 'To claimant: spoofed', '111'));
    expect(env.ctx.repo.listMessages(claim.itemId)).toHaveLength(1);
    expect(env.highlevel.emails).toHaveLength(0);
  });

  it('retries only the team notifications that failed', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { messaging } = env.ctx.services;
    const m = messaging.postFromPortal(claim, 'Hello');
    const notify = vi.spyOn(env.monday, 'notifyUser');
    notify.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Monday down'));

    await expect(messaging.deliverPortalMessage(m.id)).rejects.toThrow('Monday down');
    notify.mockRestore();
    await messaging.deliverPortalMessage(m.id);

    expect(env.monday.callsTo('createUpdate')).toHaveLength(1);
    expect(env.monday.notifications.map((n) => n.userId)).toEqual(['222']);
  });
});

describe('handleInbound', () => {
  it('replies to STATUS by SMS with the current status, recording nothing', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env, { amountClaimed: 4321 });
    const portalUrl = env.ctx.services.tokens.portalUrl(claim);
    const ev = inbound('  status ', { messageId: 'hl_status_1' });

    await env.ctx.services.messaging.handleInbound(ev);
    await env.ctx.services.messaging.handleInbound(ev); // redelivered

    expect(env.highlevel.sms).toHaveLength(1);
    const sms = env.highlevel.sms[0]!;
    expect(sms.contactId).toBe(CONTACT);
    expect(sms.message).toContain(claim.claimNumber);
    expect(sms.message).toContain('New');
    expect(sms.message).toContain(portalUrl);
    expect(sms.message).not.toContain('4,321');
    expect(env.ctx.repo.listMessages(claim.itemId)).toEqual([]);
    expect(env.monday.callsTo('createUpdate')).toHaveLength(0);
    expect(env.ctx.jobs.list()).toHaveLength(0);
  });

  it('STOP opts every claim of the contact out of SMS and tells the team once; START opts back in', async () => {
    const env = makeTestEnv();
    const a = makeClaim(env, { receivedAt: '2026-10-01T00:00:00.000Z' });
    const b = makeClaim(env, { receivedAt: '2026-10-20T00:00:00.000Z' });
    const { messaging } = env.ctx.services;
    const stop = inbound('Stop', { messageId: 'hl_stop_1' });

    env.monday.failNext = 1; // the first Monday post fails; the job retries
    await expect(messaging.handleInbound(stop)).rejects.toThrow();
    expect(env.ctx.repo.getClaim(a.itemId)!.smsOptedOut).toBe(true);
    expect(env.ctx.repo.getClaim(b.itemId)!.smsOptedOut).toBe(true);
    await messaging.handleInbound(stop);
    await messaging.handleInbound(stop);

    // Posted updates only (the failed call is recorded in `calls` too).
    const posts = [...env.monday.updates.values()];
    expect(posts.map((p) => p.itemId).sort()).toEqual([a.itemId, b.itemId].sort());
    for (const p of posts) expect(p.textBody).toBe('Claimant opted out of text messages; updates will go by email.');
    expect(env.ctx.repo.listMessages(a.itemId)).toEqual([]);
    expect(env.ctx.repo.listMessages(b.itemId)).toEqual([]);

    await messaging.handleInbound(inbound('YES'));
    expect(env.ctx.repo.getClaim(a.itemId)!.smsOptedOut).toBe(false);
    expect(env.ctx.repo.getClaim(b.itemId)!.smsOptedOut).toBe(false);
    expect(env.ctx.repo.listMessages(b.itemId)).toEqual([]);

    // Opted in again, "Yes" is an answer for the team.
    await messaging.handleInbound(inbound('Yes'));
    expect(env.ctx.repo.listMessages(b.itemId).map((m) => m.body)).toEqual(['Yes']);
  });

  it('ignores HELP and messages from contacts without a claim', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    await env.ctx.services.messaging.handleInbound(inbound('help'));
    await env.ctx.services.messaging.handleInbound(inbound('Hello?', { contactId: 'contact_unknown' }));
    expect(env.ctx.repo.listMessages(claim.itemId)).toEqual([]);
    expect(env.highlevel.sms).toHaveLength(0);
    expect(env.ctx.jobs.list()).toHaveLength(0);
  });

  it('stores an SMS reply on the most recent open claim and queues its Monday post once', async () => {
    const env = makeTestEnv();
    const open = makeClaim(env, { receivedAt: '2026-09-01T00:00:00.000Z', statusKey: 'under_review', statusLabel: 'Under review' });
    const closed = makeClaim(env, { receivedAt: '2026-10-01T00:00:00.000Z', statusKey: 'closed', statusLabel: 'Closed' });
    const ev = inbound('The driver left it in the rain', { messageId: 'hl_sms_9' });

    await env.ctx.services.messaging.handleInbound(ev);
    await env.ctx.services.messaging.handleInbound(ev);

    expect(env.ctx.repo.listMessages(closed.itemId)).toEqual([]);
    const msgs = env.ctx.repo.listMessages(open.itemId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'from_claimant', channel: 'sms', body: 'The driver left it in the rain', highlevelMessageId: 'hl_sms_9' });
    expect(env.ctx.jobs.list().filter((j) => j.type === JOB.portalMessageToMonday)).toHaveLength(1);

    await env.ctx.jobs.drain();
    const posts = env.monday.callsTo('createUpdate');
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(open.itemId);
    expect(posts[0]![1]).toContain('From claimant (text):');
  });

  it('falls back to the most recent claim when all are closed', async () => {
    const env = makeTestEnv();
    makeClaim(env, { receivedAt: '2026-09-01T00:00:00.000Z', statusKey: 'denied', statusLabel: 'Denied' });
    const latest = makeClaim(env, { receivedAt: '2026-10-01T00:00:00.000Z', statusKey: 'closed', statusLabel: 'Closed' });
    await env.ctx.services.messaging.handleInbound(inbound('Any update?'));
    expect(env.ctx.repo.listMessages(latest.itemId)).toHaveLength(1);
  });

  it('strips the quoted thread from email replies; keywords only apply to SMS', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const body = [
      'Thanks, the receipt is attached.',
      '',
      'Jane',
      '',
      'On Tue, Oct 21, 2026 at 9:14 AM Home Delivery Claims <',
      'claims@claims.test> wrote:',
      '> You have a new message about claim HDC-000001:',
      '> Please send the receipt.',
    ].join('\n');

    await env.ctx.services.messaging.handleInbound(inbound(body, { channel: 'email', messageId: 'hl_email_1' }));
    await env.ctx.services.messaging.handleInbound(inbound('STOP', { channel: 'email', messageId: 'hl_email_2' }));
    await env.ctx.jobs.drain();

    const msgs = env.ctx.repo.listMessages(claim.itemId);
    expect(msgs.map((m) => [m.channel, m.body])).toEqual([
      ['email', 'Thanks, the receipt is attached.\n\nJane'],
      ['email', 'STOP'],
    ]);
    expect(env.ctx.repo.getClaim(claim.itemId)!.smsOptedOut).toBe(false);
    expect(env.monday.callsTo('createUpdate')[0]![1]).toContain('From claimant (email):');
  });
});

describe('stripEmailReply', () => {
  it('drops quoted lines and everything after an attribution line', () => {
    expect(stripEmailReply('Yes, that works.\n\nOn Mon, Oct 20, 2026, Claims <c@x.com> wrote:\n> old text')).toBe('Yes, that works.');
    expect(stripEmailReply('See inline:\n> question one\nAnswer one\n> question two\nAnswer two')).toBe(
      'See inline:\nAnswer one\nAnswer two',
    );
  });

  it('stops at Outlook headers, Original Message markers, signatures and mobile footers', () => {
    expect(stripEmailReply('New text\n\n-----Original Message-----\nFrom: Claims\nOld text')).toBe('New text');
    expect(stripEmailReply('New text\n\nFrom: Home Delivery Claims <c@x.com>\nSent: Tuesday\nTo: Jane\nOld')).toBe('New text');
    expect(stripEmailReply('New text\n________________________________\nFrom: Claims\nOld')).toBe('New text');
    expect(stripEmailReply('New text\n-- \nJane Doe\n555-0100')).toBe('New text');
    expect(stripEmailReply('New text\n\nSent from my iPhone')).toBe('New text');
  });

  it('handles HTML bodies and keeps everything when only quotes would remain', () => {
    expect(stripEmailReply('<div>Hello <b>team</b></div><div class="gmail_quote">On ... wrote:<blockquote>old</blockquote></div>')).toBe(
      'Hello team',
    );
    expect(stripEmailReply('> only a quote')).toBe('> only a quote');
  });
});
