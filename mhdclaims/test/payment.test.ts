import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseBoardConfig } from '../src/board-config.js';
import { JOB } from '../src/services/contracts.js';
import boardExample from '../config/board.example.json' with { type: 'json' };
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

  it('labels a submission with an unknown claim number as a mismatch', async () => {
    const env = makeTestEnv();
    await claimFor(env);
    const unknown = submitPaymentForm(env, 'HDC-424242', 'x'.repeat(22));
    await env.ctx.services.payment.handlePaymentItemCreated(unknown.id);
    expect(labelOf(env, unknown.id)).toBe('Check claim number');
    expect(env.monday.callsTo('createUpdate')).toHaveLength(0);
    expect(pendingJobs(env)).toEqual([]);
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

// Pending payment jobs (type, dedupe key, seconds until due).
const pendingJobs = (env: TestEnv) =>
  (env.ctx.db.prepare("SELECT type, dedupe_key, run_at FROM jobs WHERE status = 'pending' AND type = ? ORDER BY id").all(JOB.paymentItemCreated) as Array<{ type: string; dedupe_key: string; run_at: string }>).map(
    (j) => ({ type: j.type, dedupeKey: j.dedupe_key, inSeconds: Math.round((new Date(j.run_at).getTime() - Date.now()) / 1000) }),
  );

// Runs the payment job as the webhook queues it, then every re-check it
// schedules, moving the clock past each. Returns the getItem count.
async function runPaymentJobs(env: TestEnv, itemId: string, between: () => void = () => {}): Promise<number> {
  env.ctx.jobs.enqueue(JOB.paymentItemCreated, { itemId }, { dedupeKey: `payment:${itemId}` });
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await env.ctx.jobs.drain();
    for (let i = 0; i < 5 && pendingJobs(env).length; i++) {
      between();
      vi.setSystemTime(Date.now() + 4 * 60_000);
      await env.ctx.jobs.drain();
    }
  } finally {
    vi.useRealTimers();
  }
  return env.monday.callsTo('getItem').filter(([id]) => id === itemId).length;
}

describe('payment links and "Replace the claim link"', () => {
  it('stop verifying once the claim link has been replaced; the new link verifies', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const oldUrl = new URL(env.ctx.services.payment.paymentFormUrl(claim));
    const { tokens } = env.ctx.services;
    const rotated = env.ctx.repo.rotatePortalToken(claim.itemId, (id, v) => tokens.tokenHash(tokens.portalToken(id, v)))!;
    const newUrl = new URL(env.ctx.services.payment.paymentFormUrl(rotated));
    expect(newUrl.searchParams.get('ref')).not.toBe(oldUrl.searchParams.get('ref'));
    expect(env.ctx.services.payment.paymentSignature(claim.claimNumber)).toBe(newUrl.searchParams.get('ref')); // current version by default

    const leaked = submitPaymentForm(env, oldUrl.searchParams.get('claim')!, oldUrl.searchParams.get('ref')!);
    await env.ctx.services.payment.handlePaymentItemCreated(leaked.id);
    expect(labelOf(env, leaked.id)).toBe('Check claim number');
    expect(env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt).toBeNull();
    expect(updatesOn(env, claim.itemId).join(' ')).toContain("didn't verify");

    const genuine = submitPaymentForm(env, newUrl.searchParams.get('claim')!, newUrl.searchParams.get('ref')!);
    await env.ctx.services.payment.handlePaymentItemCreated(genuine.id);
    expect(labelOf(env, genuine.id)).toBe('Verified');
    expect(env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt).not.toBeNull();
  });

  it('keeps links sent before versioning working for claims whose link was never replaced', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    expect(claim.tokenVersion).toBe(1);
    const legacy = createHmac('sha256', env.config.APP_SECRET).update(`payment:${claim.claimNumber}`).digest('base64url').slice(0, 22);
    expect(new URL(env.ctx.services.payment.paymentFormUrl(claim)).searchParams.get('ref')).toBe(legacy);
  });
});

describe('payment: a second verified submission', () => {
  it('is labelled a duplicate, and the team is warned with both item ids', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const url = new URL(env.ctx.services.payment.paymentFormUrl(claim));
    const first = submitPaymentForm(env, url.searchParams.get('claim')!, url.searchParams.get('ref')!);
    await env.ctx.services.payment.handlePaymentItemCreated(first.id);
    const receivedAt = env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt;
    expect(receivedAt).not.toBeNull();

    const second = submitPaymentForm(env, url.searchParams.get('claim')!, url.searchParams.get('ref')!);
    await env.ctx.services.payment.handlePaymentItemCreated(second.id);

    expect(labelOf(env, first.id)).toBe('Verified');
    expect(labelOf(env, second.id)).toBe('Duplicate submission');
    expect(env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt).toBe(receivedAt);
    const updates = updatesOn(env, claim.itemId);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toContain('Payment details were submitted again for this claim');
    expect(updates[1]).toContain(`payment details board item ${second.id}`);
    expect(updates[1]).toContain(`payment details board item ${first.id}`);
    expect(updates[1]).toContain('"Duplicate submission"');
    expect(updates.filter((u) => u.includes('(verified)'))).toHaveLength(1);
    expect(env.ctx.repo.listMessages(claim.itemId).filter((m) => m.body === 'Payment details received')).toHaveLength(1);
    expect(JSON.stringify(env.monday.calls)).not.toContain(BANK.account);

    // Jobs re-run: the first stays the accepted one, nothing is posted twice.
    await env.ctx.services.payment.handlePaymentItemCreated(first.id);
    await env.ctx.services.payment.handlePaymentItemCreated(second.id);
    expect(labelOf(env, first.id)).toBe('Verified');
    expect(labelOf(env, second.id)).toBe('Duplicate submission');
    expect(updatesOn(env, claim.itemId)).toHaveLength(2);
  });

  it('uses the configured duplicate label, defaulting to "Duplicate submission"', () => {
    const { duplicateLabel: _omitted, ...pb } = boardExample.paymentBoard;
    expect(parseBoardConfig({ ...boardExample, paymentBoard: pb }).paymentBoard!.duplicateLabel).toBe('Duplicate submission');
  });
});

describe('payment: create_item before the form answers', () => {
  it('checks again later instead of flagging a submission whose columns are still empty', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const url = new URL(env.ctx.services.payment.paymentFormUrl(claim));
    const pb = env.board.paymentBoard!;
    const item = submitPaymentForm(env, '', '');

    const reads = await runPaymentJobs(env, item.id, () => {
      // The answers land between the first look and the re-check.
      env.monday.mustItem(item.id).columnValues[pb.claimNumberColumn]!.text = url.searchParams.get('claim');
      env.monday.mustItem(item.id).columnValues[pb.signatureColumn]!.text = url.searchParams.get('ref');
    });

    expect(reads).toBe(2);
    expect(env.monday.callsTo('changeColumnValues').filter(([, id]) => id === item.id)).toEqual([[pb.boardId, item.id, { [pb.verificationColumn]: { label: 'Verified' } }]]);
    expect(env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt).not.toBeNull();
    expect(updatesOn(env, claim.itemId).join(' ')).not.toContain("didn't verify");
  });

  it('schedules the re-checks over about five minutes', async () => {
    const env = makeTestEnv();
    await claimFor(env);
    const item = submitPaymentForm(env, '', '');
    await env.ctx.services.payment.handlePaymentItemCreated(item.id);
    expect(env.monday.callsTo('changeColumnValues').filter(([, id]) => id === item.id)).toEqual([]);
    expect(pendingJobs(env)).toEqual([{ type: JOB.paymentItemCreated, dedupeKey: `payment-recheck:${item.id}:1`, inSeconds: 30 }]);
  });

  it('flags it once the re-checks are used up and a column is still empty', async () => {
    const env = makeTestEnv();
    const claim = await claimFor(env);
    const blank = submitPaymentForm(env, '', '');
    const noRef = submitPaymentForm(env, claim.claimNumber, '');

    expect(await runPaymentJobs(env, blank.id)).toBe(4);
    expect(await runPaymentJobs(env, noRef.id)).toBe(4);

    expect(labelOf(env, blank.id)).toBe('Check claim number');
    expect(labelOf(env, noRef.id)).toBe('Check claim number');
    expect(env.monday.callsTo('changeColumnValues').filter(([boardId]) => boardId === env.board.paymentBoard!.boardId)).toHaveLength(2);
    expect(env.ctx.repo.getClaim(claim.itemId)!.paymentDetailsReceivedAt).toBeNull();
    const updates = updatesOn(env, claim.itemId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`didn't verify — check it before paying (payment details board item ${noRef.id})`);
  });
});
