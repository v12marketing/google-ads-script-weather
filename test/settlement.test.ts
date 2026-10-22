import { describe, expect, it, vi } from 'vitest';
import { JOB } from '../src/services/contracts.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

async function newClaim(env: TestEnv, o: Parameters<typeof addClaimItem>[1] & { settlement?: string } = {}) {
  const item = addClaimItem(env, o);
  if (o.settlement !== undefined) env.monday.setText(item.id, env.board.columns.settlementAmount, o.settlement, 'numbers');
  await env.ctx.services.intake.handleItemCreated(item.id);
  return item;
}

const claimOf = (env: TestEnv, itemId: string) => env.ctx.repo.getClaim(itemId)!;
// FakeMonday strips tags but leaves entities; Monday's text_body has them decoded.
const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const updatesOn = (env: TestEnv, itemId: string) =>
  [...env.monday.updates.values()].filter((u) => u.itemId === itemId).map((u) => decode(u.textBody));
const statusWrites = (env: TestEnv, itemId: string) =>
  (env.monday.callsTo('changeColumnValues') as Array<[string, string, Record<string, unknown>]>)
    .filter(([, id, values]) => id === itemId && env.board.columns.status in values)
    .map(([, , values]) => values[env.board.columns.status]);

async function sendSigned(env: TestEnv, itemId: string) {
  await env.ctx.services.settlement.sendSettlement(claimOf(env, itemId));
  const claim = claimOf(env, itemId);
  const { documentId } = env.ctx.repo.getSettlementRefs(itemId);
  env.highlevel.sign(documentId!);
  return { claim, documentId: documentId! };
}

describe('settlement.sendSettlement', () => {
  it('posts an update and sends nothing when the amount is missing', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env);
    await expect(env.ctx.services.settlement.sendSettlement(claimOf(env, item.id))).resolves.toBeUndefined();

    expect(env.highlevel.settlementRequests).toHaveLength(0);
    expect(claimOf(env, item.id).settlementSentAt).toBeNull();
    expect(updatesOn(env, item.id)).toEqual([
      'Settlement offered, but the settlement amount column is empty, so no document was sent. Fill it in and set the status again.',
    ]);
  });

  it('refuses a zero amount', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '0' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(0);
    expect(updatesOn(env, item.id)[0]).toMatch(/isn't above \$0/);
  });

  it('sends the document and stores both ids and the amount sent', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '1,200.50' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));

    const claim = claimOf(env, item.id);
    expect(env.highlevel.settlementRequests).toEqual([
      {
        contactId: claim.highlevelContactId,
        claimNumber: 'HDC-000001',
        itemId: item.id,
        settlementAmount: 1200.5,
        claimantName: 'Jane Doe',
        portalUrl: env.ctx.services.tokens.portalUrl(claim),
      },
    ]);
    expect(claim).toMatchObject({ settlementAmount: 1200.5, settlementAmountSent: 1200.5, settlementSignedAt: null });
    expect(claim.settlementSentAt).not.toBeNull();
    const refs = env.ctx.repo.getSettlementRefs(item.id);
    expect(refs.documentId).toMatch(/^doc_/);
    expect(refs.referenceId).toBe(`ref_${refs.documentId}`);
    expect(updatesOn(env, item.id)).toEqual(['Settlement document sent to the claimant for signature ($1,200.50).']);
  });

  it('is idempotent for the same amount', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(updatesOn(env, item.id)).toHaveLength(1);
  });

  it('sends a new document when the amount changed and asks the team to void the old one', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    const first = env.ctx.repo.getSettlementRefs(item.id).documentId;

    env.monday.setText(item.id, env.board.columns.settlementAmount, '1100', 'numbers');
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));

    expect(env.highlevel.settlementRequests.map((r) => r.settlementAmount)).toEqual([900, 1100]);
    expect(env.ctx.repo.getSettlementRefs(item.id).documentId).not.toBe(first);
    expect(claimOf(env, item.id).settlementAmountSent).toBe(1100);
    const updates = updatesOn(env, item.id);
    expect(updates.some((u) => u.includes('changed from $900.00 to $1,100.00') && u.includes('void the earlier document in HighLevel'))).toBe(true);

    // A late signature on the superseded document is not accepted.
    env.highlevel.sign(first!);
    await env.ctx.services.settlement.handleDocumentSigned({
      kind: 'document_signed',
      contactId: claimOf(env, item.id).highlevelContactId,
      documentId: first,
      claimNumber: 'HDC-000001',
    });
    expect(claimOf(env, item.id).settlementSignedAt).toBeNull();
  });

  it("blocks a second open settlement for the same HighLevel contact", async () => {
    const env = makeTestEnv();
    const a = await newClaim(env, { settlement: '500' });
    const b = await newClaim(env, { settlement: '700', name: 'Jane Doe' });
    expect(claimOf(env, a.id).highlevelContactId).toBe(claimOf(env, b.id).highlevelContactId);

    await env.ctx.services.settlement.sendSettlement(claimOf(env, a.id));
    await env.ctx.services.settlement.sendSettlement(claimOf(env, b.id));

    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(claimOf(env, b.id).settlementSentAt).toBeNull();
    expect(updatesOn(env, b.id)[0]).toMatch(/other claim HDC-000001 already has a settlement waiting for signature/);

    // Once A is signed, B can go out.
    env.highlevel.sign();
    await env.ctx.services.settlement.reconcilePending();
    await env.ctx.services.settlement.sendSettlement(claimOf(env, b.id));
    expect(env.highlevel.settlementRequests).toHaveLength(2);
  });

  it('tells the team when the claim has no email or phone', async () => {
    const env = makeTestEnv();
    const item = env.monday.addItem(env.board.claimsBoardId, 'No Contact', {
      [env.board.columns.settlementAmount]: { type: 'numbers', text: '300' },
    });
    await env.ctx.services.intake.handleItemCreated(item.id);
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    expect(env.highlevel.settlementRequests).toHaveLength(0);
    expect(updatesOn(env, item.id)).toContain(
      "Settlement offered, but there's no email or phone on this claim, so no document could be sent. Add one and set the status again.",
    );
  });
});

describe('settlement.handleDocumentSigned', () => {
  it('verifies, records the signature, moves the board and posts the PDF instructions', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    const notify = vi.spyOn(env.ctx.services.notifier, 'notify');
    const { claim, documentId } = await sendSigned(env, item.id);

    await env.ctx.services.settlement.handleDocumentSigned({
      kind: 'document_signed',
      contactId: claim.highlevelContactId,
      documentId,
      claimNumber: claim.claimNumber,
    });

    const after = claimOf(env, item.id);
    expect(after.settlementSignedAt).not.toBeNull();
    expect(statusWrites(env, item.id)).toEqual([{ label: 'Settlement signed' }]);
    expect(env.monday.items.get(item.id)!.columnValues[env.board.columns.status]!.text).toBe('Settlement signed');
    const update = updatesOn(env, item.id).at(-1)!;
    expect(update).toMatch(/^Settlement signed by the claimant on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(signer IP 203\.0\.113\.7\)\./);
    expect(update).toContain("HighLevel doesn't make the signed PDF available to the integration.");
    expect(update).toContain('Payments → Documents & Contracts');
    expect(update).not.toContain('Check the amount');
    // The status webhook sends the claimant message, not this handler.
    expect(notify).not.toHaveBeenCalled();

    // Redelivery: nothing more happens.
    const updates = updatesOn(env, item.id).length;
    await env.ctx.services.settlement.handleDocumentSigned({
      kind: 'document_signed',
      contactId: claim.highlevelContactId,
      documentId,
      claimNumber: claim.claimNumber,
    });
    expect(updatesOn(env, item.id)).toHaveLength(updates);
    expect(statusWrites(env, item.id)).toHaveLength(1);
  });

  it('matches by claim number when the workflow sends no document id', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    const { claim } = await sendSigned(env, item.id);
    await env.ctx.services.settlement.handleDocumentSigned({
      kind: 'document_signed',
      contactId: claim.highlevelContactId,
      documentId: null,
      claimNumber: 'hdc-000001',
    });
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
  });

  it("uses the contact's open settlement when the claim number field has moved on", async () => {
    const env = makeTestEnv();
    const a = await newClaim(env, { settlement: '900' });
    const { claim } = await sendSigned(env, a.id);
    // A newer claim for the same person rewrites the contact's claim_number field.
    const b = await newClaim(env, {});
    await env.ctx.services.settlement.handleDocumentSigned({
      kind: 'document_signed',
      contactId: claim.highlevelContactId,
      documentId: null,
      claimNumber: claimOf(env, b.id).claimNumber,
    });
    expect(claimOf(env, a.id).settlementSignedAt).not.toBeNull();
  });

  it('does nothing when the API says the document is not signed', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    const claim = claimOf(env, item.id);
    const updates = updatesOn(env, item.id).length;

    await env.ctx.services.settlement.handleDocumentSigned({
      kind: 'document_signed',
      contactId: claim.highlevelContactId,
      documentId: env.ctx.repo.getSettlementRefs(item.id).documentId,
      claimNumber: claim.claimNumber,
    });
    expect(claimOf(env, item.id).settlementSignedAt).toBeNull();
    expect(statusWrites(env, item.id)).toHaveLength(0);
    expect(updatesOn(env, item.id)).toHaveLength(updates);
  });

  it('does not trust a document marked complete by hand', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    const claim = claimOf(env, item.id);
    vi.spyOn(env.highlevel, 'verifySignedDocument').mockResolvedValue({
      signed: false,
      reason: 'missing_signatures',
      signedAt: null,
      signerIp: null,
      documentName: 'Settlement',
    });
    const event = { kind: 'document_signed' as const, contactId: claim.highlevelContactId, documentId: null, claimNumber: claim.claimNumber };
    await env.ctx.services.settlement.handleDocumentSigned(event);
    await env.ctx.services.settlement.handleDocumentSigned(event);

    expect(claimOf(env, item.id).settlementSignedAt).toBeNull();
    expect(statusWrites(env, item.id)).toHaveLength(0);
    expect(updatesOn(env, item.id).filter((u) => u.includes('not every signer has signed'))).toHaveLength(1);
  });

  it('ignores an event whose contact does not match the claim', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    const { claim, documentId } = await sendSigned(env, item.id);
    await env.ctx.services.settlement.handleDocumentSigned({
      kind: 'document_signed',
      contactId: 'contact_someone_else',
      documentId,
      claimNumber: claim.claimNumber,
    });
    expect(claimOf(env, item.id).settlementSignedAt).toBeNull();
    expect(env.highlevel.calls.filter((c) => c.method === 'verifySignedDocument')).toHaveLength(0);
  });

  it('ignores an event that matches no claim', async () => {
    const env = makeTestEnv();
    await expect(
      env.ctx.services.settlement.handleDocumentSigned({ kind: 'document_signed', contactId: 'c', documentId: 'doc_x', claimNumber: 'HDC-999999' }),
    ).resolves.toBeUndefined();
  });

  it('flags a board amount that changed after the document was sent', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    const { claim, documentId } = await sendSigned(env, item.id);
    env.monday.setText(item.id, env.board.columns.settlementAmount, '950', 'numbers');
    await env.ctx.services.settlement.handleDocumentSigned({ kind: 'document_signed', contactId: claim.highlevelContactId, documentId, claimNumber: null });
    expect(updatesOn(env, item.id).at(-1)).toContain(
      'Check the amount: the document was signed for $900.00, but the settlement amount on the board is now $950.00.',
    );
  });

  it('does not move the board back from a later status', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    const { claim, documentId } = await sendSigned(env, item.id);
    env.monday.setText(item.id, env.board.columns.status, 'Payment sent', 'status');
    await env.ctx.services.settlement.handleDocumentSigned({ kind: 'document_signed', contactId: claim.highlevelContactId, documentId, claimNumber: null });
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
    expect(statusWrites(env, item.id)).toHaveLength(0);
  });

  it('end to end: offered on the board -> signed -> board label -> claimant told about payment', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    env.monday.setText(item.id, env.board.columns.status, 'Settlement offered', 'status');
    env.ctx.jobs.enqueue(JOB.mondayStatusChanged, { itemId: item.id, label: 'Settlement offered', eventId: 'e1' });
    await env.ctx.jobs.runDue();
    expect(env.highlevel.settlementRequests).toHaveLength(1);

    env.highlevel.sign();
    const claim = claimOf(env, item.id);
    env.ctx.jobs.enqueue(JOB.highlevelDocumentSigned, { kind: 'document_signed', contactId: claim.highlevelContactId, documentId: null, claimNumber: claim.claimNumber });
    await env.ctx.jobs.runDue();
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();

    // Monday then fires the status webhook for the label we set.
    const emails = env.highlevel.emails.length;
    env.ctx.jobs.enqueue(JOB.mondayStatusChanged, { itemId: item.id, label: 'Settlement signed', eventId: 'e2' });
    await env.ctx.jobs.runDue();
    expect(env.highlevel.emails).toHaveLength(emails + 1);
    expect(env.highlevel.emails.at(-1)!.text).toContain(env.ctx.services.payment.paymentFormUrl(claimOf(env, item.id)));
    expect(claimOf(env, item.id).statusKey).toBe('settlement_signed');
    expect(env.ctx.jobs.list('dead')).toHaveLength(0);
  });
});

describe('settlement.handleDocumentDeclined', () => {
  it('tells the team, notifies the configured users and frees the contact for a new settlement', async () => {
    const env = makeTestEnv();
    const a = await newClaim(env, { settlement: '500' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, a.id));
    const claim = claimOf(env, a.id);

    const event = { kind: 'document_declined' as const, contactId: claim.highlevelContactId, claimNumber: claim.claimNumber };
    await env.ctx.services.settlement.handleDocumentDeclined(event);
    await env.ctx.services.settlement.handleDocumentDeclined(event);

    expect(updatesOn(env, a.id).filter((u) => u.startsWith('The claimant declined the settlement document'))).toHaveLength(1);
    expect(env.monday.notifications).toEqual([
      { userId: '111', itemId: a.id, text: 'Claim HDC-000001: the claimant declined the settlement.' },
      { userId: '222', itemId: a.id, text: 'Claim HDC-000001: the claimant declined the settlement.' },
    ]);
    expect(claimOf(env, a.id).settlementSentAt).toBeNull();

    // Same amount again: a fresh document goes out.
    await env.ctx.services.settlement.sendSettlement(claimOf(env, a.id));
    expect(env.highlevel.settlementRequests).toHaveLength(2);
  });

  it('never undoes a real signature', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '900' });
    const { claim } = await sendSigned(env, item.id);
    await env.ctx.services.settlement.handleDocumentDeclined({ kind: 'document_declined', contactId: claim.highlevelContactId, claimNumber: claim.claimNumber });
    expect(claimOf(env, item.id).settlementSignedAt).not.toBeNull();
    expect(env.monday.notifications).toHaveLength(0);
  });
});

describe('settlement.reconcilePending', () => {
  it('records signatures the webhook missed and keeps going past errors', async () => {
    const env = makeTestEnv();
    const a = await newClaim(env, { settlement: '500' });
    const b = await newClaim(env, { settlement: '700', email: 'bob@example.com', phone: '+16035550222' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, a.id));
    await env.ctx.services.settlement.sendSettlement(claimOf(env, b.id));
    env.highlevel.sign(env.ctx.repo.getSettlementRefs(a.id).documentId!);
    env.highlevel.sign(env.ctx.repo.getSettlementRefs(b.id).documentId!);

    env.highlevel.failNext = 1; // the first check fails
    await expect(env.ctx.services.settlement.reconcilePending()).resolves.toBeUndefined();
    const signed = [a.id, b.id].filter((id) => claimOf(env, id).settlementSignedAt);
    expect(signed).toHaveLength(1);

    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, a.id).settlementSignedAt).not.toBeNull();
    expect(claimOf(env, b.id).settlementSignedAt).not.toBeNull();
    expect(env.ctx.repo.listClaimsAwaitingSignature()).toHaveLength(0);
  });

  it('frees a settlement whose document was deleted or expired in HighLevel', async () => {
    const env = makeTestEnv();
    const item = await newClaim(env, { settlement: '500' });
    await env.ctx.services.settlement.sendSettlement(claimOf(env, item.id));
    vi.spyOn(env.highlevel, 'verifySignedDocument').mockResolvedValue({
      signed: false,
      reason: 'expired',
      signedAt: null,
      signerIp: null,
      documentName: null,
    });
    await env.ctx.services.settlement.reconcilePending();
    expect(claimOf(env, item.id).settlementSentAt).toBeNull();
    expect(updatesOn(env, item.id).at(-1)).toMatch(/was expired in HighLevel, so it can no longer be signed/);
  });
});
