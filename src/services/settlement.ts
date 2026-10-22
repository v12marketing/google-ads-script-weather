import type { HighLevelEvent } from '../adapters/highlevel/types.js';
import type { MondayWriteOptions } from '../adapters/monday/types.js';
import { statusKeyForLabel } from '../board-config.js';
import { nowIso } from '../db/index.js';
import type { Claim, StatusKey } from '../domain/types.js';
import { html, type Html } from '../web/html.js';
import { columnText, errMessage, formatUsd, formatUtc, onceFor, parseAmount } from './claim-fields.js';
import type { CoreContext, Services, SettlementService } from './contracts.js';
import { RetryLaterError } from './jobs.js';
import { ContactConflictError } from './notifier.js';

// 'missing': the stored document isn't in HighLevel's document list (not yet, or
// no longer: declined and deleted documents drop out of it).
// 'void': it can no longer be signed, and the claim's settlement is closed.
// 'untracked': there are no document ids to check (and none could be found).
type Verification = 'signed' | 'pending' | 'missing' | 'void' | 'untracked';

const HOUR = 60 * 60 * 1000;
// A send whose outcome is unknown (timed out, 5xx, process stopped) is not
// repeated until HighLevel has had this long to list the document it may have
// sent, and none turned up.
export const RESEND_AFTER_MS = 10 * 60 * 1000;
// A document HighLevel returned no ids for, or a send of unknown outcome that was
// never retried: the poller looks for it this long, then tells the team and stops.
export const UNTRACKED_GIVE_UP_MS = 24 * HOUR;
// A stored document missing from the list (deleted, declined, archived): the
// poller stops waiting once it has been gone this long since it was last seen,
// or, if it was never seen, this long after it was sent.
export const MISSING_AFTER_SEEN_MS = 24 * HOUR;
export const MISSING_NEVER_SEEN_MS = 14 * 24 * HOUR;
// The most claims one 15-minute poller run checks (least recently checked first).
export const RECONCILE_BATCH = 20;

// Statuses the board must not be moved back from when a signature is confirmed late.
const AT_OR_PAST_SIGNED: StatusKey[] = ['settlement_signed', 'payment_sent', 'closed', 'denied'];

const PDF_NOTE =
  "HighLevel doesn't make the signed PDF available to the integration. Download it from HighLevel (Payments → Documents & Contracts) and attach it to the signed settlement file column so it appears on the claim page.";

export function createSettlementService(ctx: CoreContext, services: Services): SettlementService {
  const { board, repo, monday, highlevel, log } = ctx;
  const cols = board.columns;

  const post = (itemId: string, body: Html, opts?: MondayWriteOptions): Promise<string> => monday.createUpdate(itemId, body.value, opts);
  // A document is out for signature.
  const isOpen = (c: Claim): boolean => !!c.settlementSentAt && !c.settlementSignedAt;
  // Open, or a send whose outcome isn't known yet: either way the contact's
  // claim_number / settlement_amount fields are in use.
  const isBusy = (c: Claim): boolean => !c.settlementSignedAt && (!!c.settlementSentAt || !!c.settlementAttemptAt);
  // The contact the tracked document went to, and the one a send of unknown
  // outcome went to. The claim's own contact may have moved on since (an email
  // or phone edit re-syncs it); the document and its signer stay where they were.
  const docContactOf = (c: Claim): string | null => c.settlementContactId ?? c.highlevelContactId;
  const attemptContactOf = (c: Claim): string | null => c.settlementAttemptContactId ?? c.highlevelContactId;
  // The contacts whose claim_number / settlement_amount fields the claim's open
  // settlement (or unconfirmed send) relies on.
  const settlementContacts = (c: Claim): string[] =>
    [c.settlementSentAt ? docContactOf(c) : null, c.settlementAttemptAt ? attemptContactOf(c) : null].filter((v): v is string => !!v);
  // Claims other than itemId with a settlement open on the contact.
  const busyOn = (contactId: string, itemId?: string): Claim[] =>
    repo.findClaimsUsingContact(contactId).filter((c) => c.itemId !== itemId && isBusy(c) && settlementContacts(c).includes(contactId));
  const ageMs = (iso: string | null): number => (iso ? Date.now() - Date.parse(iso) : 0);
  const money = (n: number | null): string => (n === null ? 'an unknown amount' : formatUsd(n));
  const offeredLabel = Object.entries(board.statuses).find(([, k]) => k === 'settlement_offered')?.[0] ?? 'Settlement offered';
  const docKeyOf = (itemId: string): string => {
    const refs = repo.getSettlementRefs(itemId);
    return refs.documentId ?? refs.referenceId ?? 'none';
  };
  const hasRefs = (itemId: string): boolean => docKeyOf(itemId) !== 'none';
  const sentKey = (itemId: string): string => `settlement-sent:${itemId}:${docKeyOf(itemId)}`;

  // Confirms the document went out; once per document, so a retry that skips the
  // send still posts it if the first attempt failed after sending.
  const announceSent = (claim: Claim): Promise<boolean> =>
    onceFor(ctx, sentKey(claim.itemId), (once) =>
      post(claim.itemId, html`<p>Settlement document sent to the claimant for signature (${money(claim.settlementAmountSent)}).</p>`, once),
    );

  // A send whose document ids we don't have: one whose outcome is unknown
  // (settlementAttemptAt), or one HighLevel returned no ids for. Looks for a
  // document sent to the contact since then and tracks it, so that a retry never
  // sends a second settlement and its signature is still recognised.
  async function discoverDocument(claim: Claim): Promise<Claim> {
    const itemId = claim.itemId;
    const refs = repo.getSettlementRefs(itemId);
    const noIds = isOpen(claim) && !refs.documentId && !refs.referenceId;
    const attempt = claim.settlementSignedAt ? null : claim.settlementAttemptAt;
    const since = attempt ?? (noIds ? claim.settlementSentAt : null);
    const contactId = attempt ? attemptContactOf(claim) : docContactOf(claim);
    if (!since || !contactId) return claim;

    // The document already tracked (an earlier offer still open) isn't the one.
    const found = await highlevel.findSentDocuments(contactId, since, [refs]);
    const doc = found[0];
    if (!doc) return claim;
    claim =
      repo.updateClaim(itemId, {
        settlementDocumentId: doc.documentId,
        settlementReferenceId: doc.referenceId,
        settlementContactId: contactId,
        ...(attempt ? { settlementAmountSent: claim.settlementAttemptAmount, settlementSentAt: doc.createdAt ?? attempt } : {}),
        settlementAttemptAt: null,
        settlementAttemptAmount: null,
        settlementAttemptContactId: null,
        settlementSeenAt: nowIso(),
        settlementSignUrl: doc.signUrl,
      }) ?? claim;
    log.info({ itemId, claimNumber: claim.claimNumber }, 'settlement: found the document HighLevel sent, tracking it');
    await onceFor(ctx, sentKey(itemId), (once) =>
      post(
        itemId,
        html`<p>Settlement document sent to the claimant for signature (${money(claim.settlementAmountSent)}). HighLevel didn't confirm it at the time; the integration has since found the document there and will confirm the signature automatically.</p>`,
        once,
      ),
    );
    if (found.length > 1) {
      await onceFor(ctx, `settlement-extra-documents:${itemId}:${docKeyOf(itemId)}`, (once) =>
        post(
          itemId,
          html`<p>HighLevel shows ${found.length} documents sent to this claimant since ${formatUtc(since)}. The integration tracks the first one; please void the others in HighLevel (Payments → Documents &amp; Contracts) so the claimant can't sign them.</p>`,
          once,
        ),
      );
    }
    return claim;
  }

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

    // An earlier send failed or timed out after HighLevel may have sent the
    // document (or the process stopped mid-request). Look for that document
    // before anything else; send again only once none has turned up.
    let unconfirmedAt: string | null = null;
    if (claim.settlementAttemptAt) {
      claim = await discoverDocument(claim);
      const at = claim.settlementAttemptAt;
      if (at) {
        const wait = RESEND_AFTER_MS - ageMs(at);
        if (wait > 0) {
          throw new RetryLaterError('settlement: an earlier send is unconfirmed; checking HighLevel for its document before sending again', wait);
        }
        unconfirmedAt = at;
        claim = repo.updateClaim(itemId, { settlementAttemptAt: null, settlementAttemptAmount: null, settlementAttemptContactId: null }) ?? claim;
      }
    }

    if (isOpen(claim) && claim.settlementAmountSent === amount) {
      // Set again for the same amount: make sure the document can still be signed.
      const result = await verifyAndRecord(claim);
      claim = repo.getClaim(itemId) ?? claim;
      // Signed: recorded and posted by verifyAndRecord.
      if (result === 'signed') return;
      if (result === 'missing' && claim.settlementSeenAt) {
        // It was in HighLevel's list and no longer is (deleted, declined,
        // archived): staff asked again, so a new one goes out.
        const gone = claim;
        await onceFor(ctx, `settlement-gone:${itemId}:${docKeyOf(itemId)}`, (once) =>
          post(
            itemId,
            html`<p>The settlement document sent ${formatUtc(gone.settlementSentAt)} is no longer in HighLevel's document list (it may have been deleted, declined or archived), so a new one is being sent.</p>`,
            once,
          ),
        );
        claim = repo.updateClaim(itemId, { settlementSentAt: null, settlementSignUrl: null }) ?? claim;
      } else if (result !== 'void') {
        log.info({ itemId }, 'settlement: already sent for this amount');
        if (hasRefs(itemId)) await announceSent(claim);
        const sentTo = docContactOf(claim);
        if (sentTo && claim.highlevelContactId && sentTo !== claim.highlevelContactId) {
          // The claimant's email or phone changed after the document went out, so
          // it went to their old details and stays there.
          await onceFor(ctx, `settlement-old-contact:${itemId}:${docKeyOf(itemId)}`, (once) =>
            post(
              itemId,
              html`<p>Settlement offered, but no new document was sent: the one sent ${formatUtc(claim.settlementSentAt)} for this amount is still open for signing. It went to the claimant's email and phone as they were then, before they were changed on this item.</p>
<p>If the claimant can't get to it, void it in HighLevel (Payments → Documents &amp; Contracts) and set the status to ${offeredLabel} again: a new document then goes to their current details.</p>`,
              once,
            ),
          );
        }
        return;
      }
      // Deleted, expired or gone in HighLevel: send a new one.
    }
    if (!claim.email && !claim.phone) {
      await post(
        itemId,
        html`<p>Settlement offered, but there's no email or phone on this claim, so no document could be sent. Add one and set the status again.</p>`,
      );
      return;
    }

    let contactId: string;
    try {
      contactId = await services.notifier.ensureContact(claim);
    } catch (err) {
      // The notifier explains the contact problem on the item only once; this
      // says what it stopped this time. Still thrown, so the claimant isn't told
      // about an offer that didn't go out.
      if (err instanceof ContactConflictError) {
        await post(
          itemId,
          html`<p>Settlement offered, but no document was sent: HighLevel has no contact that reaches only this claimant (see the note about their contact on this item). Once that is fixed, set the status to ${offeredLabel} again.</p>`,
        );
      }
      throw err;
    }
    claim = repo.getClaim(itemId) ?? claim;

    // claim_number and settlement_amount live on the HighLevel contact, shared by all
    // of that person's claims: a second open document would show the wrong values.
    const blocking = busyOn(contactId, itemId);
    if (blocking.length) {
      await post(
        itemId,
        html`<p>Settlement offered, but no document was sent: this claimant's other claim ${blocking.map((c) => c.claimNumber).join(', ')} already has a settlement waiting for signature.</p>
<p>HighLevel keeps the claim number and amount on the contact, shared by all their claims, so only one settlement can be out at a time. Once that one is signed, or the integration posts on that claim that its document can no longer be signed, set this claim's status to ${offeredLabel} again.</p>`,
      );
      log.info({ itemId }, 'settlement: blocked by another open settlement for the same contact');
      return;
    }

    if (isOpen(claim)) {
      // Amount changed since the last document. It may have been signed meanwhile
      // (the webhook can lag): then that agreement stands and nothing is sent.
      const oldKey = docKeyOf(itemId);
      const result = await verifyAndRecord(claim);
      const before = claim;
      claim = repo.getClaim(itemId) ?? claim;
      if (result === 'signed') {
        await onceFor(ctx, `settlement-reoffer-signed:${itemId}:${oldKey}`, (once) =>
          post(
            itemId,
            html`<p>Settlement offered for ${money(amount)}, but the claimant had already signed the earlier settlement document for ${money(before.settlementAmountSent)}, so no new document was sent.</p>`,
            once,
          ),
        );
        return;
      }
      if (result !== 'void') {
        // The API can't void documents.
        await onceFor(ctx, `settlement-superseded:${itemId}:${oldKey}`, (once) =>
          post(
            itemId,
            html`<p>The settlement amount changed from ${money(before.settlementAmountSent)} to ${money(amount)}, so a new settlement document is being sent.</p>
<p>Please void the earlier document in HighLevel (Payments → Documents &amp; Contracts) so the claimant can't sign it. A signature on the earlier document won't be accepted.</p>`,
            once,
          ),
        );
      }
    }

    // Recorded before the request: if it fails or times out, HighLevel may still
    // have sent the document, and the retry looks for it instead of sending another.
    const attemptAt = nowIso();
    claim = repo.updateClaim(itemId, { settlementAttemptAt: attemptAt, settlementAttemptAmount: amount, settlementAttemptContactId: contactId }) ?? claim;
    const refs = await highlevel.requestSettlementSignature({
      contactId,
      claimNumber: claim.claimNumber,
      itemId,
      settlementAmount: amount,
      claimantName: claim.claimantName,
      portalUrl: services.tokens.portalUrl(claim),
    });
    const tracked = !!refs.documentId || !!refs.referenceId;
    claim =
      repo.updateClaim(itemId, {
        settlementDocumentId: refs.documentId,
        settlementReferenceId: refs.referenceId,
        settlementContactId: contactId,
        settlementAmountSent: amount,
        // Without ids the poller looks for a document sent since the request started.
        settlementSentAt: tracked ? nowIso() : attemptAt,
        settlementAttemptAt: null,
        settlementAttemptAmount: null,
        settlementAttemptContactId: null,
        settlementSeenAt: null,
        settlementSignUrl: null,
      }) ?? claim;
    log.info({ itemId, claimNumber: claim.claimNumber }, 'settlement: document sent');
    if (unconfirmedAt) {
      await onceFor(ctx, `settlement-resent:${itemId}:${unconfirmedAt}`, (once) =>
        post(
          itemId,
          html`<p>HighLevel didn't confirm an earlier attempt to send the settlement document (${formatUtc(unconfirmedAt)}), and no document from it could be found there, so it was sent again. If the claimant received two settlement documents, please void the older one in HighLevel (Payments → Documents &amp; Contracts).</p>`,
          once,
        ),
      );
    }
    if (!tracked) {
      await post(
        itemId,
        html`<p>Settlement document sent (${money(amount)}), but HighLevel returned no document id. The integration will look for the document in HighLevel and confirm the signature automatically once it finds it; if it can't find it within ${UNTRACKED_GIVE_UP_MS / HOUR} hours, it will say so here.</p>`,
      );
      return;
    }
    await announceSent(claim);
  }

  // Checks the stored document through the API and, when it is properly signed,
  // records it. Steps run in retry-safe order: settlementSignedAt is set last.
  async function verifyAndRecord(input: Claim): Promise<Verification> {
    if (input.settlementSignedAt) return 'signed';
    const itemId = input.itemId;
    if (!docContactOf(input) && !attemptContactOf(input)) return 'untracked';
    const claim = await discoverDocument(input);
    const refs = repo.getSettlementRefs(itemId);
    // The signer must be the contact the document went to.
    const contactId = docContactOf(claim);
    if ((!refs.documentId && !refs.referenceId) || !contactId) return 'untracked';
    const docKey = refs.documentId ?? refs.referenceId;

    const check = await highlevel.verifySignedDocument(refs, contactId, { sentAt: claim.settlementSentAt });
    if (check.reason !== 'not_found') {
      repo.markSettlementChecked(itemId, { seenAt: nowIso() });
      // The claimant's own signing link, for the claim page. Never logged.
      if (check.signUrl && check.signUrl !== claim.settlementSignUrl) repo.updateClaim(itemId, { settlementSignUrl: check.signUrl });
    }
    if (!check.signed) {
      log.info({ itemId, reason: check.reason }, 'settlement: document not signed yet');
      if (check.reason === 'missing_signatures') {
        // Staff can "Mark as Completed" in HighLevel without anyone signing.
        await onceFor(ctx, `settlement-incomplete:${itemId}:${docKey}`, (once) =>
          post(
            itemId,
            html`<p>HighLevel shows the settlement document as completed, but not every signer has signed it (it may have been marked complete by hand). The claim was not marked as signed.</p>`,
            once,
          ),
        );
      }
      if ((check.reason === 'deleted' || check.reason === 'expired') && claim.settlementSentAt) {
        await onceFor(ctx, `settlement-void:${itemId}:${docKey}`, (once) =>
          post(
            itemId,
            html`<p>The settlement document for this claim was ${check.reason} in HighLevel, so it can no longer be signed. Set the status to ${offeredLabel} again to send a new one.</p>`,
            once,
          ),
        );
        repo.updateClaim(itemId, { settlementSentAt: null, settlementSignUrl: null });
        return 'void';
      }
      return check.reason === 'not_found' ? 'missing' : 'pending';
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
    await onceFor(ctx, `settlement-signed:${itemId}:${docKey}`, (once) =>
      post(
        itemId,
        html`<p>Settlement signed by the claimant on ${formatUtc(check.signedAt)} (signer IP ${check.signerIp ?? 'not recorded'}).</p>
${amountChanged ? html`<p><strong>Check the amount:</strong> the document was signed for ${money(sent)}, but the settlement amount on the board is now ${boardAmount === null ? 'empty' : money(boardAmount)}.</p>` : ''}
<p>${PDF_NOTE}</p>`,
        once,
      ),
    );

    record();
    log.info({ itemId, claimNumber: claim.claimNumber }, 'settlement: signature verified');
    return 'signed';
  }

  // Webhook events carry little we can trust. Match by document id, else claim
  // number. The workflow's claim number is the contact's custom field, which
  // follows the contact's latest claim, so the contact's single open settlement
  // wins over a claim-number match that has none open. The webhook comes from
  // the contact the document went to, which may no longer be the claim's own.
  function findClaim(e: { contactId: string | null; documentId: string | null; claimNumber: string | null }): Claim | null {
    const byDocument = e.documentId ? repo.getClaimBySettlementDocument(e.documentId) : null;
    const byNumber = e.claimNumber ? repo.getClaimByNumber(e.claimNumber) : null;
    const openForContact = e.contactId ? busyOn(e.contactId) : [];
    const claim =
      byDocument ??
      (byNumber && isBusy(byNumber) ? byNumber : null) ??
      (openForContact.length === 1 ? openForContact[0]! : null) ??
      byNumber;
    const known = claim ? [claim.highlevelContactId, claim.settlementContactId, claim.settlementAttemptContactId].filter((v): v is string => !!v) : [];
    if (claim && e.contactId && known.length && !known.includes(e.contactId)) {
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

  // The Declined workflow carries only the contact and its claim_number field, and
  // a decline can't be read through the API (declined documents drop out of the
  // list). So it is applied only when it fits the claim's current document: that
  // document is no longer in HighLevel's list (or HighLevel gave no ids for it and
  // the claim number matches), and it has been out long enough to be listed. A
  // current document still open for signing means the decline was for an earlier,
  // superseded one (or a late repeat): nothing changes.
  async function handleDocumentDeclined(event: Extract<HighLevelEvent, { kind: 'document_declined' }>): Promise<void> {
    const claim = findClaim({ ...event, documentId: null });
    if (!claim) {
      log.warn({ hasClaimNumber: !!event.claimNumber }, 'settlement: declined webhook matches no claim');
      return;
    }
    const itemId = claim.itemId;
    if (!isBusy(claim)) {
      log.info({ itemId }, 'settlement: declined webhook for a claim with no settlement out, ignoring');
      return;
    }
    // Never let a stray decline undo a real signature.
    const result = await verifyAndRecord(claim);
    const current = repo.getClaim(itemId) ?? claim;
    if (result === 'signed' || result === 'void') return;
    if (result === 'pending') {
      log.info({ itemId }, 'settlement: declined webhook, but the current document is still open in HighLevel; ignoring');
      await onceFor(ctx, `settlement-decline-ignored:${itemId}:${docKeyOf(itemId)}`, (once) =>
        post(
          itemId,
          html`<p>HighLevel reported a declined settlement document for this claimant, but the current one (sent ${formatUtc(current.settlementSentAt)} for ${money(current.settlementAmountSent)}) is still open for signing in HighLevel, so the decline was taken to be for an earlier document and nothing was changed. If the claimant declined the current document, check it in HighLevel.</p>`,
          once,
        ),
      );
      return;
    }
    if (result === 'untracked' && event.claimNumber !== claim.claimNumber) {
      log.info({ itemId }, 'settlement: declined webhook for another claim number, and no document ids to check; ignoring');
      return;
    }
    // A document sent moments ago may not be listed yet: look again shortly.
    const wait = RESEND_AFTER_MS - ageMs(current.settlementSentAt ?? current.settlementAttemptAt);
    if (wait > 0) throw new RetryLaterError('settlement: declined webhook for a document sent moments ago; checking again shortly', wait);

    const docKey = docKeyOf(itemId);
    await onceFor(ctx, `settlement-declined:${itemId}:${docKey}`, (once) =>
      post(
        itemId,
        html`<p>The claimant declined the settlement document in HighLevel, so it can no longer be signed. Follow up with them, then set the status to ${offeredLabel} again to send a new document.</p>`,
        once,
      ),
    );
    for (const userId of board.notifyUserIds) {
      await onceFor(ctx, `settlement-declined:${itemId}:${docKey}:notify:${userId}`, (once) =>
        monday.notifyUser(userId, itemId, `Claim ${claim.claimNumber}: the claimant declined the settlement.`, once),
      );
    }
    // No longer open, so the poller stops checking it and a new document can go
    // out (to this or another of their claims).
    repo.updateClaim(itemId, {
      settlementSentAt: null,
      settlementAttemptAt: null,
      settlementAttemptAmount: null,
      settlementAttemptContactId: null,
      settlementSignUrl: null,
    });
  }

  // A send or document that can't be found, or identified, in HighLevel for long
  // enough is given up on, with a note to the team, so it doesn't block the
  // claimant's settlements (and use up the poller) forever.
  async function giveUpIfStale(claim: Claim, result: Verification): Promise<void> {
    const itemId = claim.itemId;
    if (claim.settlementSignedAt || result === 'signed' || result === 'void') return;
    const giveUp = async (key: string, what: Html, clear: Parameters<typeof repo.updateClaim>[1]) => {
      await onceFor(ctx, key, (once) =>
        post(
          itemId,
          html`${what}
<p>Please check this claimant's documents in HighLevel (Payments → Documents &amp; Contracts). If they signed, set the status to ${board.settlementSignedLabel}; if not, set it to ${offeredLabel} again to send a new document.</p>`,
          once,
        ),
      );
      repo.updateClaim(itemId, clear);
      log.info({ itemId, result }, 'settlement: stopped waiting for a document HighLevel does not list');
    };

    // A send of unknown outcome whose document never turned up.
    const attemptAt = claim.settlementAttemptAt;
    if (attemptAt && ageMs(attemptAt) >= UNTRACKED_GIVE_UP_MS) {
      await giveUp(
        `settlement-gave-up:${itemId}:${attemptAt}`,
        html`<p>HighLevel didn't confirm an attempt to send the settlement document (${formatUtc(attemptAt)}, ${money(claim.settlementAttemptAmount)}), and no document from it has turned up there, so the integration has stopped looking for it.</p>`,
        { settlementAttemptAt: null, settlementAttemptAmount: null, settlementAttemptContactId: null },
      );
    }
    const sentAt = claim.settlementSentAt;
    if (!isOpen(claim) || !sentAt) return;
    if (result === 'untracked' && ageMs(sentAt) >= UNTRACKED_GIVE_UP_MS) {
      // HighLevel returned no ids, and the document never turned up.
      await giveUp(
        `settlement-gave-up:${itemId}:${sentAt}`,
        html`<p>HighLevel returned no document id for the settlement document sent ${formatUtc(sentAt)} (${money(claim.settlementAmountSent)}), and the integration couldn't find it in HighLevel's document list, so it has stopped waiting for its signature.</p>`,
        { settlementSentAt: null, settlementSignUrl: null },
      );
      return;
    }
    const seenAt = claim.settlementSeenAt;
    if (result === 'missing' && (seenAt ? ageMs(seenAt) >= MISSING_AFTER_SEEN_MS : ageMs(sentAt) >= MISSING_NEVER_SEEN_MS)) {
      await giveUp(
        `settlement-gave-up:${itemId}:${docKeyOf(itemId)}`,
        html`<p>The settlement document sent ${formatUtc(sentAt)} (${money(claim.settlementAmountSent)}) ${
          seenAt ? html`hasn't been in HighLevel's document list since ${formatUtc(seenAt)}` : html`has never shown up in HighLevel's document list`
        }. It may have been deleted, declined or archived, so the integration has stopped waiting for its signature.</p>`,
        { settlementSentAt: null, settlementSignUrl: null },
      );
    }
  }

  async function reconcilePending(): Promise<void> {
    for (const claim of repo.listSettlementsToCheck(RECONCILE_BATCH)) {
      // Marked first, so a claim whose check keeps failing doesn't hold up the rest.
      repo.markSettlementChecked(claim.itemId, { checkedAt: nowIso() });
      try {
        const result = await verifyAndRecord(claim);
        await giveUpIfStale(repo.getClaim(claim.itemId) ?? claim, result);
      } catch (err) {
        log.warn({ itemId: claim.itemId, err: errMessage(err) }, 'settlement: reconcile check failed');
      }
    }
  }

  return { sendSettlement, handleDocumentSigned, handleDocumentDeclined, reconcilePending };
}
