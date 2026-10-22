import type { HighLevelEvent } from '../adapters/highlevel/types.js';
import { statusKeyForLabel } from '../board-config.js';
import { nowIso } from '../db/index.js';
import type { Claim, StatusKey } from '../domain/types.js';
import { html, type Html } from '../web/html.js';
import { columnText, errMessage, formatUsd, formatUtc, onceFor, parseAmount } from './claim-fields.js';
import type { CoreContext, Services, SettlementService } from './contracts.js';

type Verification = 'signed' | 'pending' | 'void' | 'untracked';

// Statuses the board must not be moved back from when a signature is confirmed late.
const AT_OR_PAST_SIGNED: StatusKey[] = ['settlement_signed', 'payment_sent', 'closed', 'denied'];

const PDF_NOTE =
  "HighLevel doesn't make the signed PDF available to the integration. Download it from HighLevel (Payments → Documents & Contracts) and attach it to the signed settlement file column so it appears on the claim page.";

export function createSettlementService(ctx: CoreContext, services: Services): SettlementService {
  const { board, repo, monday, highlevel, log } = ctx;
  const cols = board.columns;

  const post = (itemId: string, body: Html): Promise<string> => monday.createUpdate(itemId, body.value);
  const isOpen = (c: Claim): boolean => !!c.settlementSentAt && !c.settlementSignedAt;
  const money = (n: number | null): string => (n === null ? 'an unknown amount' : formatUsd(n));
  const offeredLabel = Object.entries(board.statuses).find(([, k]) => k === 'settlement_offered')?.[0] ?? 'Settlement offered';
  const docKeyOf = (itemId: string): string => {
    const refs = repo.getSettlementRefs(itemId);
    return refs.documentId ?? refs.referenceId ?? 'none';
  };

  // Confirms the document went out; once per document, so a retry that skips the
  // send still posts it if the first attempt failed after sending.
  const announceSent = (claim: Claim): Promise<boolean> =>
    onceFor(ctx, `settlement-sent:${claim.itemId}:${docKeyOf(claim.itemId)}`, () =>
      post(claim.itemId, html`<p>Settlement document sent to the claimant for signature (${money(claim.settlementAmountSent)}).</p>`),
    );

  async function sendSettlement(input: Claim): Promise<void> {
    const itemId = input.itemId;
    const item = await monday.getItem(itemId, [cols.settlementAmount]);
    if (!item) {
      log.warn({ itemId }, 'settlement: item not found');
      return;
    }
    const amount = parseAmount(item.columnValues[cols.settlementAmount]);
    let claim = repo.updateClaim(itemId, { settlementAmount: amount }) ?? input;

    if (claim.settlementSignedAt) {
      await post(
        itemId,
        html`<p>Settlement offered, but this claim's settlement was already signed (${formatUtc(claim.settlementSignedAt)}), so no new document was sent.</p>`,
      );
      return;
    }
    if (amount === null) {
      await post(
        itemId,
        html`<p>Settlement offered, but the settlement amount column is empty, so no document was sent. Fill it in and set the status again.</p>`,
      );
      return;
    }
    if (amount <= 0) {
      await post(
        itemId,
        html`<p>Settlement offered, but the settlement amount isn't above $0, so no document was sent. Correct it and set the status again.</p>`,
      );
      return;
    }
    if (isOpen(claim) && claim.settlementAmountSent === amount) {
      log.info({ itemId }, 'settlement: already sent for this amount');
      await announceSent(claim);
      return;
    }
    if (!claim.email && !claim.phone) {
      await post(
        itemId,
        html`<p>Settlement offered, but there's no email or phone on this claim, so no document could be sent. Add one and set the status again.</p>`,
      );
      return;
    }

    const contactId = await services.notifier.ensureContact(claim);
    claim = repo.getClaim(itemId) ?? claim;

    // claim_number and settlement_amount live on the HighLevel contact, shared by all
    // of that person's claims: a second open document would show the wrong values.
    const blocking = repo.findClaimsByContact(contactId).filter((c) => c.itemId !== itemId && isOpen(c));
    if (blocking.length) {
      await post(
        itemId,
        html`<p>Settlement offered, but no document was sent: this claimant's other claim ${blocking.map((c) => c.claimNumber).join(', ')} already has a settlement waiting for signature.</p>
<p>HighLevel keeps the claim number and amount on the contact, shared by all their claims, so only one settlement can be out at a time. Once that one is signed (or deleted in HighLevel, which the integration notices within about 15 minutes), set this claim's status to ${offeredLabel} again.</p>`,
      );
      log.info({ itemId }, 'settlement: blocked by another open settlement for the same contact');
      return;
    }

    if (isOpen(claim)) {
      // Amount changed since the last document. The API can't void documents.
      await onceFor(ctx, `settlement-superseded:${itemId}:${docKeyOf(itemId)}`, () =>
        post(
          itemId,
          html`<p>The settlement amount changed from ${money(claim.settlementAmountSent)} to ${money(amount)}, so a new settlement document is being sent.</p>
<p>Please void the earlier document in HighLevel (Payments → Documents &amp; Contracts) so the claimant can't sign it. A signature on the earlier document won't be accepted.</p>`,
        ),
      );
    }

    const refs = await highlevel.requestSettlementSignature({
      contactId,
      claimNumber: claim.claimNumber,
      itemId,
      settlementAmount: amount,
      claimantName: claim.claimantName,
      portalUrl: services.tokens.portalUrl(claim),
    });
    claim =
      repo.updateClaim(itemId, {
        settlementDocumentId: refs.documentId,
        settlementReferenceId: refs.referenceId,
        settlementAmountSent: amount,
        settlementSentAt: nowIso(),
      }) ?? claim;
    log.info({ itemId, claimNumber: claim.claimNumber }, 'settlement: document sent');
    if (!refs.documentId && !refs.referenceId) {
      await post(
        itemId,
        html`<p>Settlement document sent (${money(amount)}), but HighLevel returned no document id, so the signature can't be confirmed automatically. Check it in HighLevel and set the status to ${board.settlementSignedLabel} once it's signed.</p>`,
      );
      return;
    }
    await announceSent(claim);
  }

  // Checks the stored document through the API and, when it is properly signed,
  // records it. Steps run in retry-safe order: settlementSignedAt is set last.
  async function verifyAndRecord(claim: Claim): Promise<Verification> {
    if (claim.settlementSignedAt) return 'signed';
    const itemId = claim.itemId;
    const refs = repo.getSettlementRefs(itemId);
    if ((!refs.documentId && !refs.referenceId) || !claim.highlevelContactId) return 'untracked';
    const docKey = refs.documentId ?? refs.referenceId;

    const check = await highlevel.verifySignedDocument(refs, claim.highlevelContactId);
    if (!check.signed) {
      log.info({ itemId, reason: check.reason }, 'settlement: document not signed yet');
      if (check.reason === 'missing_signatures') {
        // Staff can "Mark as Completed" in HighLevel without anyone signing.
        await onceFor(ctx, `settlement-incomplete:${itemId}:${docKey}`, () =>
          post(
            itemId,
            html`<p>HighLevel shows the settlement document as completed, but not every signer has signed it (it may have been marked complete by hand). The claim was not marked as signed.</p>`,
          ),
        );
      }
      if ((check.reason === 'deleted' || check.reason === 'expired') && claim.settlementSentAt) {
        await onceFor(ctx, `settlement-void:${itemId}:${docKey}`, () =>
          post(
            itemId,
            html`<p>The settlement document for this claim was ${check.reason} in HighLevel, so it can no longer be signed. Set the status to ${offeredLabel} again to send a new one.</p>`,
          ),
        );
        repo.updateClaim(itemId, { settlementSentAt: null });
        return 'void';
      }
      return 'pending';
    }

    const signedAt = check.signedAt ?? nowIso();
    const record = () => repo.updateClaim(itemId, { settlementSignedAt: signedAt, settlementSentAt: claim.settlementSentAt ?? signedAt });
    const item = await monday.getItem(itemId, [cols.status, cols.settlementAmount]);
    if (!item) {
      // Item deleted on Monday: keep the record, nothing to update there.
      record();
      log.warn({ itemId }, 'settlement: signed, but the Monday item no longer exists');
      return 'signed';
    }
    const boardAmount = parseAmount(item.columnValues[cols.settlementAmount]);
    const currentKey = statusKeyForLabel(board, columnText(item.columnValues[cols.status]));
    // Setting the label fires the status webhook, which sends the settlement_signed message.
    if (!currentKey || !AT_OR_PAST_SIGNED.includes(currentKey)) {
      await monday.changeColumnValues(board.claimsBoardId, itemId, { [cols.status]: { label: board.settlementSignedLabel } });
    }

    const sent = claim.settlementAmountSent;
    const amountChanged = sent !== null && (boardAmount === null || Math.abs(boardAmount - sent) >= 0.005);
    await onceFor(ctx, `settlement-signed:${itemId}:${docKey}`, () =>
      post(
        itemId,
        html`<p>Settlement signed by the claimant on ${formatUtc(check.signedAt)} (signer IP ${check.signerIp ?? 'not recorded'}).</p>
${amountChanged ? html`<p><strong>Check the amount:</strong> the document was signed for ${money(sent)}, but the settlement amount on the board is now ${boardAmount === null ? 'empty' : money(boardAmount)}.</p>` : ''}
<p>${PDF_NOTE}</p>`,
      ),
    );

    record();
    log.info({ itemId, claimNumber: claim.claimNumber }, 'settlement: signature verified');
    return 'signed';
  }

  // Webhook events carry little we can trust. Match by document id, else claim
  // number. The workflow's claim number is the contact's custom field, which
  // follows the contact's latest claim, so the contact's single open settlement
  // wins over a claim-number match that has none open.
  function findClaim(e: { contactId: string | null; documentId: string | null; claimNumber: string | null }): Claim | null {
    const byDocument = e.documentId ? repo.getClaimBySettlementDocument(e.documentId) : null;
    const byNumber = e.claimNumber ? repo.getClaimByNumber(e.claimNumber) : null;
    const openForContact = e.contactId ? repo.findClaimsByContact(e.contactId).filter(isOpen) : [];
    const claim =
      byDocument ??
      (byNumber && isOpen(byNumber) ? byNumber : null) ??
      (openForContact.length === 1 ? openForContact[0]! : null) ??
      byNumber;
    if (claim && e.contactId && claim.highlevelContactId && claim.highlevelContactId !== e.contactId) {
      log.warn({ itemId: claim.itemId }, 'settlement: webhook contact does not match the claim, ignoring');
      return null;
    }
    return claim;
  }

  async function handleDocumentSigned(event: Extract<HighLevelEvent, { kind: 'document_signed' }>): Promise<void> {
    const claim = findClaim(event);
    if (!claim) {
      log.warn({ hasDocumentId: !!event.documentId, hasClaimNumber: !!event.claimNumber }, 'settlement: signed webhook matches no claim');
      return;
    }
    const result = await verifyAndRecord(claim);
    // Not signed: the poller keeps checking.
    if (result !== 'signed') log.info({ itemId: claim.itemId, result }, 'settlement: signed webhook not confirmed by the API');
  }

  async function handleDocumentDeclined(event: Extract<HighLevelEvent, { kind: 'document_declined' }>): Promise<void> {
    const claim = findClaim({ ...event, documentId: null });
    if (!claim) {
      log.warn({ hasClaimNumber: !!event.claimNumber }, 'settlement: declined webhook matches no claim');
      return;
    }
    // A decline can't be checked through the API, but a signature can: never let
    // a stray decline undo a real signature.
    const result = await verifyAndRecord(claim);
    if (result === 'signed' || result === 'untracked') return;
    const itemId = claim.itemId;
    const docKey = docKeyOf(itemId);
    await onceFor(ctx, `settlement-declined:${itemId}:${docKey}`, () =>
      post(
        itemId,
        html`<p>The claimant declined the settlement document in HighLevel, so it can no longer be signed. Follow up with them, then set the status to ${offeredLabel} again to send a new document.</p>`,
      ),
    );
    for (const userId of board.notifyUserIds) {
      await onceFor(ctx, `settlement-declined:${itemId}:${docKey}:notify:${userId}`, () =>
        monday.notifyUser(userId, itemId, `Claim ${claim.claimNumber}: the claimant declined the settlement.`),
      );
    }
    // No longer open, so a new document can go out (to this or another of their claims).
    repo.updateClaim(itemId, { settlementSentAt: null });
  }

  async function reconcilePending(): Promise<void> {
    for (const claim of repo.listClaimsAwaitingSignature()) {
      try {
        await verifyAndRecord(claim);
      } catch (err) {
        log.warn({ itemId: claim.itemId, err: errMessage(err) }, 'settlement: reconcile check failed');
      }
    }
  }

  return { sendSettlement, handleDocumentSigned, handleDocumentDeclined, reconcilePending };
}
