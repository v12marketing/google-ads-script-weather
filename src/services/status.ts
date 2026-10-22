import { statusKeyForLabel } from '../board-config.js';
import { addSystemMessageOnce } from './claim-fields.js';
import type { CoreContext, Services, StatusService } from './contracts.js';

export function createStatusService(ctx: CoreContext, services: Services): StatusService {
  const { board, repo, log } = ctx;

  async function handleStatusChanged(itemId: string, label: string | null, eventId?: string): Promise<void> {
    // Recorded only when the whole event has been handled, so a job retry after a
    // failure still runs; the steps inside are idempotent on their own keys. The
    // suffix keeps it apart from the notifier's eventKey records.
    const doneKey = eventId ? `status:${eventId}:done` : null;
    if (doneKey && repo.isEventProcessed(doneKey)) return;

    // Status changed before (or without) a create_item delivery: run intake first.
    if (!repo.getClaim(itemId)) await services.intake.handleItemCreated(itemId);
    let claim = await services.intake.refreshClaim(itemId);
    if (!claim) {
      log.warn({ itemId }, 'status: no claim for item, ignoring');
      return;
    }

    const statusLabel = label?.trim() || null;
    const key = statusKeyForLabel(board, statusLabel);
    if (!key || !statusLabel) {
      // Internal label: nothing for the claimant.
      log.info({ itemId }, 'status: internal status, no message');
      if (doneKey) repo.markEventProcessed(doneKey);
      return;
    }
    claim = repo.updateClaim(itemId, { statusKey: key, statusLabel }) ?? claim;
    // "received" says what intake's confirmation already said (Monday may fire a
    // status event for the new item's initial label). Sharing the confirmation's
    // event key sends it once, whichever runs first; the timeline already has
    // "Claim received".
    const isReceived = key === 'received';
    const eventKey = isReceived ? `confirmation:${itemId}` : `status:${eventId ?? `${itemId}:${key}`}`;

    if (key === 'settlement_offered') {
      await services.settlement.sendSettlement(claim);
      claim = repo.getClaim(itemId) ?? claim;
      // No document went out (amount missing, another open settlement, ...): the
      // settlement service has told the team; the claimant hears once it is sent.
      if (!claim.settlementSentAt || claim.settlementSignedAt) {
        if (doneKey) repo.markEventProcessed(doneKey);
        return;
      }
    }

    if (!isReceived) addSystemMessageOnce(ctx, `${eventKey}:message`, itemId, `Status updated: ${statusLabel}`);
    // settlement_signed: the template carries the payment form link.
    await services.notifier.notify(claim, key, {}, { eventKey });
    if (doneKey) repo.markEventProcessed(doneKey);
  }

  return { handleStatusChanged };
}
