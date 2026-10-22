import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TEMPLATES } from '../src/services/templates.js';
import { RetryLaterError } from '../src/services/jobs.js';
import { RECONCILE_BATCH } from '../src/services/settlement.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

// Settlement robustness: ambiguous send failures, untracked and vanished
// documents, stray declines, re-offers after signing, the poller's cost, and the
// claimant's signing link.

async function newClaim(env: TestEnv, o: Parameters<typeof addClaimItem>[1] & { settlement?: string } = {}) {
  const item = addClaimItem(env, o);
  if (o.settlement !== undefined) env.monday.setText(item.id, env.board.columns.settlementAmount, o.settlement, 'numbers');
  await env.ctx.services.intake.handleItemCreated(item.id);
  return item;
}

const claimOf = (env: TestEnv, itemId: string) => env.ctx.repo.getClaim(itemId)!;
const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const updatesOn = (env: TestEnv, itemId: string) =>
  [...env.monday.updates.values()].filter((u) => u.itemId === itemId).map((u) => decode(u.textBody));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const verifyCalls = (env: TestEnv) => env.highlevel.calls.filter((c) => c.method === 'verifySignedDocument');

describe('settlement send with an unknown outcome (#17, #20)', () => {
  it('a retry after a send that failed once HighLevel had sent the document adopts it instead of sending a second', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    env.highlevel.failAfterSend = 1;
    await expect(env.ctx.services.settlement.sendSettlement(claimOf(env, item.id))).rejects.toThrow(/timeout/);

    const pending = claimOf(env, item.id);
    expect(pending.settlementAttemptAt).not.toBeNull();
    expect(pending.settlementAttemptAmount).toBe(900);
    expect(pending.settlementSentAt).toBeNull();

    // The job retries.
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(1);
    const first = [...env.highlevel.documents.keys()][0]!;
    expect(env.ctx.repo.getSettlementRefs(item.id).documentId).toBe(first);
    const claim = claimOf(env, item.id);
    expect(claim).toMatchObject({ settlementAmountSent: 900, settlementAttemptAt: null, settlementAttemptAmount: null });
    expect(claim.settlementSentAt).not.toBeNull();
    expect(updatesOn(env, item.id).filter((u) => u.startsWith('Settlement document sent to the claimant for signature ($900.00)'))).toHaveLength(1);

    // The claimant signs that (only) document: recognised.
    env.highlevel.sign(first);
    await env.ctx.services.settlement.handleDocumentSigned({ kind: 'document_signed', contactId: claim.highlevelContactId, documentId: null, claimNumber: claim.claimNumber });
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
  });

  it('through the status job: one document, and the claimant is told once', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    env.monday.setText(item.id, env.board.columns.status, 'Settlement offered', 'status');
    env.highlevel.failAfterSend = 1;
    await expect(env.ctx.services.status.handleStatusChanged(item.id, 'Settlement offered', 'e1')).rejects.toThrow();
    const emails = env.highlevel.emails.length;
    await env.ctx.services.status.handleStatusChanged(item.id, 'Settlement offered', 'e1');
    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(env.highlevel.emails).toHaveLength(emails + 1);
    expect(env.highlevel.emails.at(-1)!.subject).toBe('Your settlement offer for claim HDC-000001 is ready');
  });

  it('waits for HighLevel to list a document before sending again, then sends once and tells the team', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    vi.spyOn(env.highlevel, 'requestSettlementSignature').mockRejectedValueOnce(new Error('HighLevel POST /proposals/templates/send timed out after 20s'));
    await expect(env.ctx.services.settlement.sendSettlement(claimOf(env, item.id))).rejects.toThrow(/timed out/);

    // Straight away: no second document, the job waits (without using up an attempt).
    const retry = await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id)).catch((e) => e);
    expect(retry).toBeInstanceOf(RetryLaterError);
    expect(env.highlevel.settlementRequests).toHaveLength(0);

    // Ten minutes on, still nothing in HighLevel: it was never sent, so send it.
    const attemptAt = ago(11 * 60 * 1000);
    env.ctx.repo.updateClaim(item.id, { settlementAttemptAt: attemptAt });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(claimOf(env, item.id)).toMatchObject({ settlementAmountSent: 900, settlementAttemptAt: null });
    expect(updatesOn(env, item.id).some((u) => u.startsWith("HighLevel didn't confirm an earlier attempt to send the settlement document"))).toBe(true);
  });

  it('a send of unknown outcome blocks the same contact\'s other claims until it is resolved', async () => {
    const env = makeTestEnv();
    const a = await newClaim(env, { settlement: '500' });
    const b = await newClaim(env, { settlement: '700' });
    vi.spyOn(env.highlevel, 'requestSettlementSignature').mockRejectedValueOnce(new Error('timeout'));
    await expect(env.ctx.services.settlement.sendSettlement(claimOf(env, a.id))).rejects.toThrow();
    await env.ctx.services.settlement.sendSettlement(claimOf(env, b.id));
    expect(env.highlevel.settlementRequests).toHaveLength(0);
    expect(updatesOn(env, b.id).at(-1)).toMatch(/other claim HDC-000001 already has a settlement waiting for signature/);
  });

  it('the poller adopts the document of an unconfirmed send, or gives up on it after a day', async () => {
    const env = makeTestEnv();
    const a = await newClaim(env, { settlement: '500' });
    env.highlevel.failAfterSend = 1;
    await expect(env.ctx.services.settlement.sendSettlement(claimOf(env, a.id))).rejects.toThrow();
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, a.id)).toMatchObject({ settlementAmountSent: 500, settlementAttemptAt: null });
    expect(env.ctx.repo.getSettlementRefs(a.id).documentId).toBe([...env.highlevel.documents.keys()][0]);

    const b = await newClaim(env, { settlement: '700', email: 'bob@example.com', phone: '+16035550222' });
    vi.spyOn(env.highlevel, 'requestSettlementSignature').mockRejectedValueOnce(new Error('timeout'));
    await expect(env.ctx.services.settlement.sendSettlement(claimOf(env, b.id))).rejects.toThrow();
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, b.id).settlementAttemptAt).not.toBeNull();
    env.ctx.repo.updateClaim(b.id, { settlementAttemptAt: ago(25 * HOUR) });
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, b.id)).toMatchObject({ settlementAttemptAt: null, settlementSentAt: null });
    expect(updatesOn(env, b.id).at(-1)).toMatch(/HighLevel didn't confirm an attempt to send the settlement document .*stopped looking for it/);
  });
});

describe('settlement verification cost (#21)', () => {
  it('passes the send time so the client can narrow the list to a date window', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    await env.ctx.services.settlement.reconcilePending();
    const [, , opts] = verifyCalls(env).at(-1)!.args as [unknown, unknown, { sentAt?: string }];
    expect(opts.sentAt).toBe(claimOf(env, item.id).settlementSentAt);
  });

  it('checks at most a batch per run, least recently checked first, so every claim gets its turn', async () => {
    const env = makeTestEnv();
    const ids: string[] = [];
    for (let i = 0; i < RECONCILE_BATCH + 3; i++) {
      const item = await newClaim(env, { email: `c${i}@example.com`, phone: `+1603555${String(1000 + i)}` });
      env.ctx.repo.updateClaim(item.id, { settlementSentAt: ago((100 - i) * 60 * 1000), settlementDocumentId: `doc_x${i}`, settlementAmountSent: 100 });
      ids.push(item.id);
    }
    const checked = () => verifyCalls(env).map((c) => env.ctx.repo.getClaimBySettlementDocument((c.args[0] as { documentId: string }).documentId)!.itemId);

    await env.ctx.services.settlement.reconcilePending();
    expect(checked()).toEqual(ids.slice(0, RECONCILE_BATCH)); // oldest first
    env.highlevel.calls = [];
    await env.ctx.services.settlement.reconcilePending();
    expect(checked().slice(0, 3)).toEqual(ids.slice(RECONCILE_BATCH)); // the rest next
    expect(checked()).toHaveLength(RECONCILE_BATCH);
  });
});

describe('settlement declines (#5)', () => {
  it('a decline for a superseded document leaves the current one open, and its signature is still recorded', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    const first = env.ctx.repo.getSettlementRefs(item.id).documentId!;
    env.monday.setText(item.id, env.board.columns.settlementAmount, '950', 'numbers');
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    const second = env.ctx.repo.getSettlementRefs(item.id).documentId!;
    expect(second).not.toBe(first);
    env.ctx.repo.updateClaim(item.id, { settlementSentAt: ago(HOUR) });

    // Staff void the old document with "Mark as Declined" (it leaves the list).
    env.highlevel.documents.delete(first);
    const claim = claimOf(env, item.id);
    await env.ctx.services.settlement.handleDocumentDeclined({ kind: 'document_declined', contactId: claim.highlevelContactId, claimNumber: claim.claimNumber });

    expect(claimOf(env, item.id).settlementSentAt).not.toBeNull();
    expect(env.monday.notifications).toHaveLength(0);
    const updates = updatesOn(env, item.id);
    expect(updates.some((u) => u.startsWith('The claimant declined'))).toBe(false);
    expect(updates.at(-1)).toMatch(/^HighLevel reported a declined settlement document .* still open for signing/);

    // The poller still checks the live document and records its signature.
    env.highlevel.sign(second);
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
  });

  it('after a decline the poller stops checking that document', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    env.ctx.repo.updateClaim(item.id, { settlementSentAt: ago(HOUR) });
    env.highlevel.documents.delete(env.ctx.repo.getSettlementRefs(item.id).documentId!);
    const claim = claimOf(env, item.id);
    await env.ctx.services.settlement.handleDocumentDeclined({ kind: 'document_declined', contactId: claim.highlevelContactId, claimNumber: claim.claimNumber });
    expect(claimOf(env, item.id).settlementSentAt).toBeNull();

    env.highlevel.calls = [];
    await env.ctx.services.settlement.reconcilePending();
    expect(verifyCalls(env)).toHaveLength(0);
  });

  it('a decline for a document sent moments ago is checked again later, not applied', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    // Not listed yet.
    env.highlevel.documents.delete(env.ctx.repo.getSettlementRefs(item.id).documentId!);
    const claim = claimOf(env, item.id);
    const err = await env.ctx.services.settlement
      .handleDocumentDeclined({ kind: 'document_declined', contactId: claim.highlevelContactId, claimNumber: claim.claimNumber })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RetryLaterError);
    expect(claimOf(env, item.id).settlementSentAt).not.toBeNull();
    expect(env.monday.notifications).toHaveLength(0);
  });
});

describe('re-offering after the claimant signed (#31)', () => {
  it('records the signature instead of superseding the signed document', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    env.highlevel.sign(env.ctx.repo.getSettlementRefs(item.id).documentId!);

    // Before the signed webhook arrives, staff lower the amount and offer again.
    env.monday.setText(item.id, env.board.columns.settlementAmount, '850', 'numbers');
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));

    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
    const updates = updatesOn(env, item.id);
    expect(updates.some((u) => u.includes('void the earlier document'))).toBe(false);
    expect(updates).toContain(
      'Settlement offered for $850.00, but the claimant had already signed the earlier settlement document for $900.00, so no new document was sent.',
    );
    expect(updates.some((u) => u.includes('Check the amount: the document was signed for $900.00'))).toBe(true);
  });
});

describe('a settlement HighLevel returned no ids for (#32)', () => {
  it('the poller finds the document and tracks it', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    env.highlevel.sendWithoutIds = 1;
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.ctx.repo.getSettlementRefs(item.id)).toEqual({ documentId: null, referenceId: null });
    expect(updatesOn(env, item.id).at(-1)).toMatch(/returned no document id\. The integration will look for the document/);

    await env.ctx.services.settlement.reconcilePending();
    const doc = [...env.highlevel.documents.keys()][0]!;
    expect(env.ctx.repo.getSettlementRefs(item.id).documentId).toBe(doc);

    env.highlevel.sign(doc);
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
  });

  it("doesn't block the contact forever: after a day unresolved, tells the team and frees it", async () => {
    const env = makeTestEnv();
    const a = await newClaim(env, { settlement: '500' });
    const b = await newClaim(env, { settlement: '700' });
    env.highlevel.sendWithoutIds = 1;
    await env.ctx.services.settlement.sendSettlement(claimOf(env, a.id));
    env.highlevel.documents.clear(); // never shows up in the list

    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, a.id).settlementSentAt).not.toBeNull();

    env.ctx.repo.updateClaim(a.id, { settlementSentAt: ago(25 * HOUR) });
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, a.id).settlementSentAt).toBeNull();
    expect(updatesOn(env, a.id).at(-1)).toMatch(/returned no document id .* stopped waiting for its signature\.\s*Please check this claimant's documents in HighLevel/);

    await env.ctx.services.settlement.sendSettlement(claimOf(env, b.id));
    expect(env.highlevel.settlementRequests.map((r) => r.settlementAmount)).toEqual([500, 700]);
  });
});

describe('a document HighLevel no longer lists (#35)', () => {
  it('gives up a day after it was last seen, and tells the team to check HighLevel', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSeenAt).not.toBeNull();

    // Deleted in HighLevel, and the list leaves it out.
    env.highlevel.documents.clear();
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSentAt).not.toBeNull();

    env.ctx.repo.markSettlementChecked(item.id, { seenAt: ago(25 * HOUR) });
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSentAt).toBeNull();
    expect(updatesOn(env, item.id).at(-1)).toMatch(/hasn't been in HighLevel's document list since .* stopped waiting for its signature/);

    env.highlevel.calls = [];
    await env.ctx.services.settlement.reconcilePending();
    expect(verifyCalls(env)).toHaveLength(0);
  });

  it('setting the status again for the same amount sends a new document once the old one has left the list', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    await env.ctx.services.settlement.reconcilePending(); // seen in HighLevel
    env.highlevel.documents.clear(); // then deleted there

    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(2);
    expect(claimOf(env, item.id).settlementSentAt).not.toBeNull();
    const updates = updatesOn(env, item.id);
    expect(updates.some((u) => /^The settlement document sent .* is no longer in HighLevel's document list/.test(u))).toBe(true);
    expect(updates.filter((u) => u.startsWith('Settlement document sent to the claimant'))).toHaveLength(2);

    // Still listed: the same amount again sends nothing.
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(2);
  });

  it('gives up on a document never seen after 14 days', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    env.highlevel.documents.clear();
    env.ctx.repo.updateClaim(item.id, { settlementSentAt: ago(13 * 24 * HOUR) });
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSentAt).not.toBeNull();
    env.ctx.repo.updateClaim(item.id, { settlementSentAt: ago(15 * 24 * HOUR) });
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSentAt).toBeNull();
    expect(updatesOn(env, item.id).at(-1)).toMatch(/has never shown up in HighLevel's document list/);
  });
});

describe("the claimant's signing link (#10)", () => {
  it('is stored from HighLevel for the open document, and cleared when a new one is sent', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(claimOf(env, item.id).settlementSignUrl).toBeNull();
    await env.ctx.services.settlement.reconcilePending();
    const first = env.ctx.repo.getSettlementRefs(item.id).documentId!;
    expect(claimOf(env, item.id).settlementSignUrl).toBe(`https://link.example.test/documents/${first}`);

    env.monday.setText(item.id, env.board.columns.settlementAmount, '950', 'numbers');
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(claimOf(env, item.id).settlementSignUrl).toBeNull();
  });

  it('the settlement email and claim-page text no longer promise a link on the claim page', () => {
    const t = DEFAULT_TEMPLATES.settlement_offered;
    expect(t.emailBody).not.toMatch(/linked on your claim page/);
    expect(t.portalText).not.toMatch(/open it from this page/);
    expect(t.emailBody).toMatch(/spam or junk folder/);
    expect(t.portalText).toMatch(/spam or junk folder/);
  });
});

describe("a settlement out while the claimant's email changes", () => {
  // An email-only claim: a new email can't match the old contact, so the claim
  // moves to another HighLevel contact, while the document stays with the old one.
  async function sentThenMoved(env: TestEnv) {
    const item = await newClaim(env, { email: 'jane@example.com', phone: '', settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    const sentTo = claimOf(env, item.id).highlevelContactId!;
    const documentId = env.ctx.repo.getSettlementRefs(item.id).documentId!;
    env.monday.setText(item.id, env.board.columns.email, 'jane.doe@work.example', 'email');
    await env.ctx.services.intake.refreshClaim(item.id);
    const movedTo = claimOf(env, item.id).highlevelContactId!;
    expect(movedTo).not.toBe(sentTo);
    expect(claimOf(env, item.id).settlementContactId).toBe(sentTo);
    return { item, sentTo, documentId };
  }

  it('tells the team once that the open document stayed with the old details', async () => {
    const env = makeTestEnv();
    const { item } = await sentThenMoved(env);
    const notes = updatesOn(env, item.id).filter((u) => u.includes("as they were before this change"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('the signature will be recognised');
    env.monday.setText(item.id, env.board.columns.email, 'jane.d@home.example', 'email');
    await env.ctx.services.intake.refreshClaim(item.id);
    expect(updatesOn(env, item.id).filter((u) => u.includes('as they were before this change'))).toHaveLength(1);
  });

  it('still recognises the signature: from the webhook of the contact it went to', async () => {
    const env = makeTestEnv();
    const { item, sentTo, documentId } = await sentThenMoved(env);
    env.highlevel.sign(documentId);
    await env.ctx.services.settlement.handleDocumentSigned({ kind: 'document_signed', contactId: sentTo, documentId: null, claimNumber: claimOf(env, item.id).claimNumber });
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
    expect(updatesOn(env, item.id).filter((u) => u.startsWith('Settlement signed by the claimant'))).toHaveLength(1);
  });

  it('still recognises the signature: from the poller', async () => {
    const env = makeTestEnv();
    const { item, sentTo, documentId } = await sentThenMoved(env);
    env.highlevel.sign(documentId);
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
    expect(verifyCalls(env).at(-1)!.args[1]).toBe(sentTo);
  });

  it('set again for the same amount: no second document, and the team hears where the open one went', async () => {
    const env = makeTestEnv();
    const { item } = await sentThenMoved(env);
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(1);
    const notes = updatesOn(env, item.id).filter((u) => u.includes('before they were changed on this item'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('void it in HighLevel');
  });

  it('set again for a new amount after the claimant signed: the signature stands, no second document', async () => {
    const env = makeTestEnv();
    const { item, documentId } = await sentThenMoved(env);
    env.highlevel.sign(documentId);
    env.monday.setText(item.id, env.board.columns.settlementAmount, '950', 'numbers');
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests.map((r) => r.settlementAmount)).toEqual([900]);
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
    expect(updatesOn(env, item.id).at(-1)).toMatch(/had already signed the earlier settlement document for \$900\.00/);
  });

  it('a send of unknown outcome is still found with the contact it went to', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { email: 'jane@example.com', phone: '', settlement: '900' });
    env.highlevel.failAfterSend = 1;
    await expect(env.ctx.services.settlement.sendSettlement(claimOf(env, item.id))).rejects.toThrow(/timeout/);
    const sentTo = claimOf(env, item.id).settlementAttemptContactId;
    expect(sentTo).toBe(claimOf(env, item.id).highlevelContactId);
    env.monday.setText(item.id, env.board.columns.email, 'jane.doe@work.example', 'email');
    await env.ctx.services.intake.refreshClaim(item.id);
    expect(claimOf(env, item.id).highlevelContactId).not.toBe(sentTo);

    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(claimOf(env, item.id)).toMatchObject({ settlementContactId: sentTo, settlementAttemptAt: null, settlementAttemptContactId: null });
    expect(env.ctx.repo.getSettlementRefs(item.id).documentId).toBe([...env.highlevel.documents.keys()][0]);
  });

  it("the one-open-settlement rule follows the document's contact, not the claim's", async () => {
    const env = makeTestEnv();
    const { item } = await sentThenMoved(env);
    // Another claim on the old address (its contact holds the open document's fields) waits...
    const old = await newClaim(env, { name: 'Jane Doe', email: 'jane@example.com', phone: '', settlement: '400' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, old.id));
    expect(updatesOn(env, old.id).at(-1)).toMatch(/already has a settlement waiting for signature/);
    // ...while one on the new address doesn't.
    const fresh = await newClaim(env, { name: 'Jane Doe', email: 'jane.doe@work.example', phone: '', settlement: '300' });
    expect(claimOf(env, fresh.id).highlevelContactId).toBe(claimOf(env, item.id).highlevelContactId);
    await env.ctx.services.settlement.sendSettlement(claimOf(env, fresh.id));
    expect(env.highlevel.settlementRequests.map((r) => r.settlementAmount)).toEqual([900, 300]);
  });
});
