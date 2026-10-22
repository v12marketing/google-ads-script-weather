import { describe, expect, it } from 'vitest';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

const BANK = { account: '000123456789', routing: '021000021' };

async function claimFor(env: TestEnv, o: Parameters<typeof addClaimItem>[1] = {}) {
  const item = addClaimItem(env, o);
  await env.ctx.services.intake.handleItemCreated(item.id);
  return env.ctx.repo.getClaim(item.id)!;
}

// A WorkForm submission on the private payment board, including bank columns
// the integration must never read.
function submitPaymentForm(env: TestEnv, claimNumber: string, signature: string, boardId = env.board.paymentBoard!.boardId) {
  const pb = env.board.paymentBoard!;
  return env.monday.addItem(boardId, 'Payment details', {
    [pb.claimNumberColumn]: { type: 'text', text: claimNumber, value: JSON.stringify(claimNumber) },
    [pb.signatureColumn]: { type: 'text', text: signature, value: JSON.stringify(signature) },
    text_account_number: { type: 'text', text: BANK.account },
    text_routing_number: { type: 'text', text: BANK.routing },
    [pb.verificationColumn]: { type: 'status', text: null },
  });
}

const labelOf = (env: TestEnv, itemId: string) =>
  env.monday.items.get(itemId)!.columnValues[env.board.paymentBoard!.verificationColumn]!.text;
const updatesOn = (env: TestEnv, itemId: string) =>
  [...env.monday.updates.values()].filter((u) => u.itemId === itemId).map((u) => u.textBody);

describe('payment links', () => {
  it('signs claim numbers with a short, stable, per-claim HMAC', () => {
    const { ctx } = makeTestEnv();
    const sig = ctx.services.payment.paymentSignature('HDC-000001');
    expect(sig).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ctx.services.payment.paymentSignature('HDC-000001')).toBe(sig);
    expect(ctx.services.payment.paymentSignature(' hdc-000001 ')).toBe(sig);
    expect(ctx.services.payment.paymentSignature('HDC-000002')).not.toBe(sig);
    // Keyed by APP_SECRET.
    const other = makeTestEnv({ config: { APP_SECRET: 'another-secret-another-secret-another-secret-0' } });
    expect(other.ctx.services.payment.paymentSignature('HDC-000001')).not.toBe(sig);
  });

  it('builds the form URL with the claim number and signature, keeping the existing query', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const url = new URL(env.ctx.services.payment.paymentFormUrl(claim));
    expect(`${url.origin}${url.pathname}`).toBe('https://forms.monday.com/forms/paymentform');
    expect(url.searchParams.get('r')).toBe('use1');
    expect(url.searchParams.get('claim')).toBe('HDC-000001');
    expect(url.searchParams.get('ref')).toBe(env.ctx.services.payment.paymentSignature('HDC-000001'));
  });
});

describe('payment.handlePaymentItemCreated', () => {
  it('verifies a genuine submission and marks the claim, reading only two columns', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const url = new URL(env.ctx.services.payment.paymentFormUrl(claim));
    const item = submitPaymentForm(env, url.searchParams.get('claim')!, url.searchParams.get('ref')!);
    env.monday.calls.length = 0;

    await env.ctx.services.payment.handlePaymentItemCreated(item.id);

    const pb = env.board.paymentBoard!;
    expect(env.monday.callsTo('getItem')).toEqual([[item.id, [pb.claimNumberColumn, pb.signatureColumn]]]);
    expect(env.monday.callsTo('changeColumnValues')).toEqual([[pb.boardId, item.id, { [pb.verificationColumn]: { label: 'Verified' } }]]);
    expect(labelOf(env, item.id)).toBe('Verified');

    const after = env.ctx.repo.getClaim(claim.itemId)!;
    expect(after.paymentDetailsReceivedAt).not.toBeNull();
    expect(env.ctx.repo.listMessages(claim.itemId).map((m) => m.body)).toContain('Payment details received');
    const updates = updatesOn(env, claim.itemId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/^Payment details were submitted \(verified\)\. Finance can find them on the payment details board\./);
    // Nothing from the payment item beyond the two columns ever left Monday.
    expect(JSON.stringify(env.monday.calls)).not.toContain(BANK.account);
    expect(updates.join(' ')).not.toContain(BANK.account);
  });

  it('is idempotent when the job runs again', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const item = submitPaymentForm(env, claim.claimNumber, env.ctx.services.payment.paymentSignature(claim.claimNumber));
    await env.ctx.services.payment.handlePaymentItemCreated(item.id);
    const first = env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt;
    await env.ctx.services.payment.handlePaymentItemCreated(item.id);

    expect(env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt).toBe(first);
    expect(updatesOn(env, claim.itemId)).toHaveLength(1);
    expect(env.ctx.repo.listMessages(claim.itemId).filter((m) => m.body === 'Payment details received')).toHaveLength(1);
  });

  it('flags a tampered claim number without marking that claim', async () => {
    const env = makeTestEnv();
    const mine = await claimFor(env);
    const victim = await claimFor(env, { email: 'victim@example.com', phone: '+16035550999' });
    // The link for my claim, edited to point at someone else's claim number.
    const item = submitPaymentForm(env, victim.claimNumber, env.ctx.services.payment.paymentSignature(mine.claimNumber));

    await env.ctx.services.payment.handlePaymentItemCreated(item.id);

    expect(labelOf(env, item.id)).toBe('Check claim number');
    expect(env.ctx.repo.getClaim(victim.itemId)!.paymentDetailsReceivedAt).toBeNull();
    expect(env.ctx.repo.getClaim(mine.itemId)!.paymentDetailsReceivedAt).toBeNull();
    expect(env.ctx.repo.listMessages(victim.itemId).map((m) => m.body)).not.toContain('Payment details received');
    const updates = updatesOn(env, victim.itemId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("A payment details submission didn't verify — check it before paying");
    expect(updatesOn(env, mine.itemId)).toHaveLength(0);
  });

  it('labels a submission with a missing or unknown claim number as a mismatch', async () => {
    const env = makeTestEnv();
    await claimFor(env);
    const blank = submitPaymentForm(env, '', '');
    const unknown = submitPaymentForm(env, 'HDC-424242', 'x'.repeat(22));
    await env.ctx.services.payment.handlePaymentItemCreated(blank.id);
    await env.ctx.services.payment.handlePaymentItemCreated(unknown.id);
    expect(labelOf(env, blank.id)).toBe('Check claim number');
    expect(labelOf(env, unknown.id)).toBe('Check claim number');
    expect(env.monday.callsTo('createUpdate')).toHaveLength(0);
  });

  it('ignores items that are not on the payment board', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const item = submitPaymentForm(env, claim.claimNumber, env.ctx.services.payment.paymentSignature(claim.claimNumber), env.board.claimsBoardId);
    env.monday.calls.length = 0;
    await env.ctx.services.payment.handlePaymentItemCreated(item.id);
    expect(env.monday.callsTo('changeColumnValues')).toHaveLength(0);
    expect(env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt).toBeNull();
  });

  it('does nothing without a configured payment board', async () => {
    const env = makeTestEnv({ board: { paymentBoard: undefined } });
    const item = env.monday.addItem('2234567890', 'Payment details', {});
    await env.ctx.services.payment.handlePaymentItemCreated(item.id);
    expect(env.monday.calls).toHaveLength(0);
  });
});
