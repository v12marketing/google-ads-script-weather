import { createHmac, timingSafeEqual } from 'node:crypto';
import { nowIso } from '../db/index.js';
import type { Claim } from '../domain/types.js';
import { html } from '../web/html.js';
import { addSystemMessageOnce, columnText, onceFor } from './claim-fields.js';
import type { CoreContext, PaymentService, Services } from './contracts.js';

const SIGNATURE_LENGTH = 22; // 132 bits of base64url

// Bank details go from the claimant's browser straight to the private payment
// board. This service reads only the claim-number and signature columns there.
export function createPaymentService(ctx: CoreContext, _services: Services): PaymentService {
  const { board, repo, monday, log } = ctx;

  const normalise = (claimNumber: string): string => claimNumber.trim().toUpperCase();

  function paymentSignature(claimNumber: string): string {
    return createHmac('sha256', ctx.config.APP_SECRET)
      .update(`payment:${normalise(claimNumber)}`)
      .digest('base64url')
      .slice(0, SIGNATURE_LENGTH);
  }

  function paymentFormUrl(claim: Claim): string {
    const url = new URL(board.paymentForm.url);
    url.searchParams.set(board.paymentForm.claimNumberParam, claim.claimNumber);
    url.searchParams.set(board.paymentForm.signatureParam, paymentSignature(claim.claimNumber));
    return url.toString();
  }

  function signatureMatches(claimNumber: string, signature: string): boolean {
    const expected = Buffer.from(paymentSignature(claimNumber));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async function handlePaymentItemCreated(itemId: string): Promise<void> {
    const pb = board.paymentBoard;
    if (!pb) return;
    // Only these two columns, never the bank details.
    const item = await monday.getItem(itemId, [pb.claimNumberColumn, pb.signatureColumn]);
    if (!item || item.boardId !== pb.boardId) {
      log.warn({ itemId }, 'payment: item not found on the payment board, ignoring');
      return;
    }
    const claimNumber = normalise(columnText(item.columnValues[pb.claimNumberColumn]) ?? '');
    const signature = columnText(item.columnValues[pb.signatureColumn]) ?? '';
    const verified = !!claimNumber && !!signature && signatureMatches(claimNumber, signature);

    await monday.changeColumnValues(pb.boardId, itemId, {
      [pb.verificationColumn]: { label: verified ? pb.verifiedLabel : pb.mismatchLabel },
    });
    log.info({ itemId, verified }, 'payment: submission checked');

    const claim = claimNumber ? repo.getClaimByNumber(claimNumber) : null;
    if (!claim) return;

    if (!verified) {
      await onceFor(ctx, `payment-mismatch:${itemId}`, () =>
        monday.createUpdate(
          claim.itemId,
          html`<p>A payment details submission didn't verify — check it before paying (payment details board item ${itemId}). The form link used wasn't the one sent for this claim, so the claim number may have been edited.</p>`
            .value,
        ),
      );
      return;
    }

    if (!claim.paymentDetailsReceivedAt) repo.updateClaim(claim.itemId, { paymentDetailsReceivedAt: nowIso() });
    addSystemMessageOnce(ctx, `payment-received:${itemId}`, claim.itemId, 'Payment details received');
    const notSigned = claim.settlementSignedAt ? '' : " Note: the settlement isn't recorded as signed yet.";
    await onceFor(ctx, `payment-received-update:${itemId}`, () =>
      monday.createUpdate(
        claim.itemId,
        html`<p>Payment details were submitted (verified). Finance can find them on the payment details board.${notSigned}</p>`.value,
      ),
    );
  }

  return { paymentFormUrl, paymentSignature, handlePaymentItemCreated };
}
