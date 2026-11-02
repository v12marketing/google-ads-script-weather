import { createHmac, timingSafeEqual } from 'node:crypto';
import { nowIso } from '../db/index.js';
import type { Claim } from '../domain/types.js';
import { html } from '../web/html.js';
import { addSystemMessageOnce, columnText, onceFor } from './claim-fields.js';
import { JOB, type CoreContext, type PaymentService, type Services } from './contracts.js';

const SIGNATURE_LENGTH = 22; // 132 bits of base64url

// create_item can fire before a WorkForm's answers are on the item, so a
// submission without its claim number or reference is looked at again
// (about 30 s, 2 min and 5 min after it arrived) before it is called a mismatch.
const RECHECK_DELAYS_MS = [30_000, 90_000, 180_000];

// Bank details go from the claimant's browser straight to the private payment
// board. This service reads only the claim-number and signature columns there.
export function createPaymentService(ctx: CoreContext, _services: Services): PaymentService {
  const { board, db, repo, monday, jobs, log } = ctx;

  const normalise = (claimNumber: string): string => claimNumber.trim().toUpperCase();

  // Bound to the claim's link version, so "Replace the claim link" also retires
  // the payment form link sent with the old one. Version 1 (never replaced)
  // signs the claim number alone, as links sent before versioning did.
  function paymentSignature(claimNumber: string, tokenVersion?: number): string {
    const n = normalise(claimNumber);
    const version = tokenVersion ?? repo.getClaimByNumber(n)?.tokenVersion ?? 1;
    return createHmac('sha256', ctx.config.APP_SECRET)
      .update(version <= 1 ? `payment:${n}` : `payment:${n}:${version}`)
      .digest('base64url')
      .slice(0, SIGNATURE_LENGTH);
  }

  function paymentFormUrl(claim: Claim): string {
    const url = new URL(board.paymentForm.url);
    url.searchParams.set(board.paymentForm.claimNumberParam, claim.claimNumber);
    url.searchParams.set(board.paymentForm.signatureParam, paymentSignature(claim.claimNumber, claim.tokenVersion));
    return url.toString();
  }

  function signatureMatches(claim: Claim, signature: string): boolean {
    const expected = Buffer.from(paymentSignature(claim.claimNumber, claim.tokenVersion));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // Queues the next look at the item; false once every re-check has been used.
  const scheduleRecheck = (itemId: string): boolean =>
    RECHECK_DELAYS_MS.some((delayMs, i) =>
      jobs.enqueue(JOB.paymentItemCreated, { itemId }, { dedupeKey: `payment-recheck:${itemId}:${i + 1}`, delayMs }),
    );

  // The payment item that supplied the claim's details is recorded together with
  // the claim's payment step, so a re-run of the job for that item is still the
  // accepted one, and any later verified item for the claim is a duplicate.
  const acceptedPrefix = (claim: Claim): string => `payment-accepted:${claim.itemId}:`;
  const accept = (claim: Claim, itemId: string): 'accepted' | 'duplicate' =>
    db.transaction(() => {
      if (repo.isEventProcessed(`${acceptedPrefix(claim)}${itemId}`)) return 'accepted' as const;
      if (repo.getClaim(claim.itemId)?.paymentDetailsReceivedAt) return 'duplicate' as const;
      repo.updateClaim(claim.itemId, { paymentDetailsReceivedAt: nowIso() });
      repo.markEventProcessed(`${acceptedPrefix(claim)}${itemId}`);
      return 'accepted' as const;
    })();

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
    if ((!claimNumber || !signature) && scheduleRecheck(itemId)) {
      log.info({ itemId }, 'payment: claim number or reference not on the item yet, checking again later');
      return;
    }

    const claim = claimNumber ? repo.getClaimByNumber(claimNumber) : null;
    const verified = !!claim && !!signature && signatureMatches(claim, signature);
    const outcome = claim && verified ? accept(claim, itemId) : 'mismatch';

    if (claim && outcome === 'duplicate') {
      // Before the label, so the team is warned even if Monday refuses it.
      const prefix = acceptedPrefix(claim);
      const first = repo.eventKeysWithPrefix(prefix)[0]?.slice(prefix.length);
      const earlier = first ? ` (payment details board item ${first})` : '';
      await onceFor(ctx, `payment-duplicate:${itemId}`, (once) =>
        monday.createUpdate(
          claim.itemId,
          html`<p>Payment details were submitted again for this claim (payment details board item ${itemId}), after an earlier submission${earlier}. The new item is labelled "${pb.duplicateLabel}". Check with the claimant which details to use before paying: the form may have been filled in twice, or the link may have reached someone else.</p>`
            .value,
          once,
        ),
      );
    }

    const label = outcome === 'accepted' ? pb.verifiedLabel : outcome === 'duplicate' ? pb.duplicateLabel : pb.mismatchLabel;
    await monday.changeColumnValues(pb.boardId, itemId, { [pb.verificationColumn]: { label } });
    log.info({ itemId, outcome }, 'payment: submission checked');

    if (!claim || outcome === 'duplicate') return;

    if (outcome === 'mismatch') {
      await onceFor(ctx, `payment-mismatch:${itemId}`, (once) =>
        monday.createUpdate(
          claim.itemId,
          html`<p>A payment details submission didn't verify — check it before paying (payment details board item ${itemId}). The form link used isn't the current one for this claim: the claim number may have been edited, or the link is from before the claim link was replaced.</p>`
            .value,
          once,
        ),
      );
      return;
    }

    addSystemMessageOnce(ctx, `payment-received:${itemId}`, claim.itemId, 'Payment details received');
    const notSigned = claim.settlementSignedAt ? '' : " Note: the settlement isn't recorded as signed yet.";
    await onceFor(ctx, `payment-received-update:${itemId}`, (once) =>
      monday.createUpdate(
        claim.itemId,
        html`<p>Payment details were submitted (verified). Finance can find them on the payment details board.${notSigned}</p>`.value,
        once,
      ),
    );
  }

  return { paymentFormUrl, paymentSignature, handlePaymentItemCreated };
}
