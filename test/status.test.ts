import { describe, expect, it, vi } from 'vitest';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

async function setup(o: Parameters<typeof addClaimItem>[1] = {}) {
  const env = makeTestEnv();
  const item = addClaimItem(env, o);
  await env.ctx.services.intake.handleItemCreated(item.id);
  // Count only what the status service sends from here on.
  env.highlevel.emails.length = 0;
  env.highlevel.sms.length = 0;
  const notify = vi.spyOn(env.ctx.services.notifier, 'notify');
  return { env, item, notify };
}

// The team moves the item to a new status on the board; Monday then fires the webhook.
async function setStatus(env: TestEnv, itemId: string, label: string, eventId?: string) {
  env.monday.setText(itemId, env.board.columns.status, label, 'status');
  await env.ctx.services.status.handleStatusChanged(itemId, label, eventId);
}

const systemMessages = (env: TestEnv, itemId: string) =>
  env.ctx.repo.listMessages(itemId).filter((m) => m.direction === 'system').map((m) => m.body);

describe('status.handleStatusChanged', () => {
  it('updates the cache, records the change and notifies the claimant', async () => {
    const { env, item, notify } = await setup();
    await setStatus(env, item.id, 'Under review', 'evt-1');

    expect(env.ctx.repo.getClaim(item.id)).toMatchObject({ statusKey: 'under_review', statusLabel: 'Under review' });
    expect(systemMessages(env, item.id)).toEqual(['Claim received', 'Status updated: Under review']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toBe('under_review');
    expect(notify.mock.calls[0]![3]).toEqual({ eventKey: 'status:evt-1' });
    expect(env.highlevel.emails).toHaveLength(1);
  });

  it('ignores a redelivered event but handles the same status set again later', async () => {
    const { env, item } = await setup();
    await setStatus(env, item.id, 'More info needed', 'evt-1');
    await setStatus(env, item.id, 'More info needed', 'evt-1');
    expect(env.highlevel.emails).toHaveLength(1);

    await setStatus(env, item.id, 'Under review', 'evt-2');
    await setStatus(env, item.id, 'More info needed', 'evt-3');
    expect(env.highlevel.emails).toHaveLength(3);
    expect(systemMessages(env, item.id).filter((m) => m === 'Status updated: More info needed')).toHaveLength(2);
  });

  it('without an event id, dedupes on the item and status', async () => {
    const { env, item } = await setup();
    await setStatus(env, item.id, 'Under review');
    await setStatus(env, item.id, 'Under review');
    expect(env.highlevel.emails).toHaveLength(1);
  });

  it('does not repeat the confirmation when the new item fires a status event for "New"', async () => {
    const { env, item } = await setup();
    await setStatus(env, item.id, 'New', 'evt-new');
    expect(env.highlevel.emails).toHaveLength(0);
    expect(env.highlevel.sms).toHaveLength(0);
    expect(systemMessages(env, item.id)).toEqual(['Claim received']);
  });

  it('confirms only once when the "New" status event is processed before create_item', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    await env.ctx.services.status.handleStatusChanged(item.id, 'New', 'evt-new');
    await env.ctx.services.intake.handleItemCreated(item.id);
    expect(env.highlevel.emails).toHaveLength(1);
    expect(env.highlevel.sms).toHaveLength(1);
  });

  it('treats unknown labels as internal: no message, cache unchanged', async () => {
    const { env, item, notify } = await setup();
    await setStatus(env, item.id, 'Waiting on carrier', 'evt-1');
    await env.ctx.services.status.handleStatusChanged(item.id, null, 'evt-2');

    expect(notify).not.toHaveBeenCalled();
    expect(env.highlevel.emails).toHaveLength(0);
    expect(env.ctx.repo.getClaim(item.id)).toMatchObject({ statusKey: 'received', statusLabel: 'New' });
    expect(systemMessages(env, item.id)).toEqual(['Claim received']);
  });

  it('matches labels case- and whitespace-insensitively', async () => {
    const { env, item, notify } = await setup();
    await setStatus(env, item.id, '  under   REVIEW ', 'evt-1');
    expect(notify.mock.calls[0]![1]).toBe('under_review');
  });

  it('runs intake first when the claim is not cached yet', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env, { status: 'Under review' });
    await env.ctx.services.status.handleStatusChanged(item.id, 'Under review', 'evt-1');

    const claim = env.ctx.repo.getClaim(item.id)!;
    expect(claim.claimNumber).toBe('HDC-000001');
    expect(claim.statusKey).toBe('under_review');
    // Confirmation from intake, then the status message.
    expect(env.highlevel.emails).toHaveLength(2);
  });

  it('retries cleanly after a failed send', async () => {
    const { env, item } = await setup({ smsOptIn: false });
    env.highlevel.failNext = 1;
    await expect(setStatus(env, item.id, 'Under review', 'evt-1')).rejects.toThrow(/simulated failure/);
    expect(env.highlevel.emails).toHaveLength(0);

    await env.ctx.services.status.handleStatusChanged(item.id, 'Under review', 'evt-1');
    expect(env.highlevel.emails).toHaveLength(1);
    expect(systemMessages(env, item.id).filter((m) => m.startsWith('Status updated'))).toHaveLength(1);
    // And it is done now.
    await env.ctx.services.status.handleStatusChanged(item.id, 'Under review', 'evt-1');
    expect(env.highlevel.emails).toHaveLength(1);
  });

  it('settlement offered: sends the document, then notifies', async () => {
    const { env, item, notify } = await setup();
    env.monday.setText(item.id, env.board.columns.settlementAmount, '900', 'numbers');
    await setStatus(env, item.id, 'Settlement offered', 'evt-1');

    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(env.highlevel.settlementRequests[0]).toMatchObject({ settlementAmount: 900, claimNumber: 'HDC-000001', itemId: item.id });
    expect(env.ctx.repo.getClaim(item.id)!.settlementSentAt).not.toBeNull();
    expect(notify.mock.calls.map((c) => c[1])).toEqual(['settlement_offered']);
    expect(env.highlevel.emails).toHaveLength(1);
  });

  it('settlement offered without an amount: tells the team, does not notify the claimant', async () => {
    const { env, item, notify } = await setup();
    await setStatus(env, item.id, 'Settlement offered', 'evt-1');

    expect(env.highlevel.settlementRequests).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    const updates = [...env.monday.updates.values()].filter((u) => u.itemId === item.id).map((u) => u.textBody);
    expect(updates).toContain(
      'Settlement offered, but the settlement amount column is empty, so no document was sent. Fill it in and set the status again.',
    );

    // Fixed and set again: now it goes out.
    env.monday.setText(item.id, env.board.columns.settlementAmount, '900', 'numbers');
    await setStatus(env, item.id, 'Settlement offered', 'evt-2');
    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(notify.mock.calls.map((c) => c[1])).toEqual(['settlement_offered']);
  });

  it('settlement signed: notifies with the payment form link', async () => {
    const { env, item, notify } = await setup();
    await setStatus(env, item.id, 'Settlement signed', 'evt-1');
    expect(notify.mock.calls.map((c) => c[1])).toEqual(['settlement_signed']);
    const claim = env.ctx.repo.getClaim(item.id)!;
    const paymentUrl = env.ctx.services.payment.paymentFormUrl(claim);
    expect(env.highlevel.emails[0]!.text).toContain(paymentUrl);
  });
});
