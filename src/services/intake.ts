import type { MondayItem } from '../adapters/monday/types.js';
import { statusKeyForLabel } from '../board-config.js';
import { nowIso } from '../db/index.js';
import type { ClaimPatch } from '../db/repo.js';
import type { Claim } from '../domain/types.js';
import { html } from '../web/html.js';
import { addSystemMessageOnce, claimColumnIds, onceFor, readClaimFields, type ClaimFields } from './claim-fields.js';
import { JOB, type CoreContext, type IntakeService, type Services } from './contracts.js';

// WorkForm files (and, per community reports, sometimes form answers) can land
// after create_item fires, so files are re-synced and missing contact details
// re-checked a little later.
const FILE_SYNC_DELAYS_MS = [30_000, 180_000];
const CONTACT_RECHECK_DELAY_MS = 120_000;

export function createIntakeService(ctx: CoreContext, services: Services): IntakeService {
  const { board, repo, monday, jobs, log } = ctx;
  const cols = board.columns;

  const fetchItem = (itemId: string): Promise<MondayItem | null> => monday.getItem(itemId, claimColumnIds(board));

  // Cached fields from the board. An unmapped (internal) status label never
  // replaces the claimant-facing status the portal shows.
  function patchFromFields(f: ClaimFields): ClaimPatch {
    const statusKey = statusKeyForLabel(board, f.statusLabel);
    return {
      claimantName: f.name,
      firstName: f.firstName,
      email: f.email,
      phone: f.phone,
      smsOptIn: f.smsOptIn,
      amountClaimed: f.amountClaimed,
      settlementAmount: f.settlementAmount,
      ...(statusKey ? { statusKey, statusLabel: f.statusLabel } : {}),
    };
  }

  const receivedAtOf = (item: MondayItem): string => {
    const t = new Date(item.createdAt).getTime();
    return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : nowIso();
  };

  async function writeBack(claim: Claim, f: ClaimFields): Promise<void> {
    const values: Record<string, unknown> = {};
    if (f.claimNumber !== claim.claimNumber) values[cols.claimNumber] = claim.claimNumber;
    const date = claim.receivedAt.slice(0, 10);
    if (cols.dateReceived && f.dateReceived !== date) values[cols.dateReceived] = { date };
    if (cols.portalLink) {
      const link = services.tokens.portalUrl(claim);
      if (f.portalLink !== link) values[cols.portalLink] = link;
    }
    if (Object.keys(values).length) await monday.changeColumnValues(board.claimsBoardId, claim.itemId, values);
  }

  async function handleItemCreated(itemId: string): Promise<void> {
    const item = await fetchItem(itemId);
    if (!item) {
      log.warn({ itemId }, 'intake: item not found, ignoring');
      return;
    }
    if (item.boardId !== board.claimsBoardId) {
      log.info({ itemId, boardId: item.boardId }, 'intake: item is not on the claims board, ignoring');
      return;
    }
    const f = readClaimFields(board, item);
    const statusKey = statusKeyForLabel(board, f.statusLabel);
    const { claim: created, created: isNew } = repo.createClaim(
      {
        itemId,
        claimantName: f.name,
        firstName: f.firstName,
        email: f.email,
        phone: f.phone,
        smsOptIn: f.smsOptIn,
        statusKey,
        statusLabel: statusKey ? f.statusLabel : null,
        amountClaimed: f.amountClaimed,
        receivedAt: receivedAtOf(item),
      },
      (id, version) => services.tokens.tokenHash(services.tokens.portalToken(id, version)),
    );
    // A redelivery or retry picks up wherever the last run stopped; every step below is idempotent.
    let claim = repo.updateClaim(itemId, patchFromFields(f)) ?? created;
    if (isNew) log.info({ itemId, claimNumber: claim.claimNumber }, 'intake: claim created');

    // Local steps first, so a Monday or HighLevel outage doesn't hold them up.
    addSystemMessageOnce(ctx, `intake-message:${itemId}`, itemId, 'Claim received');
    if (cols.intakePhotos) {
      FILE_SYNC_DELAYS_MS.forEach((delayMs, i) =>
        jobs.enqueue(
          JOB.mondayColumnChanged,
          { itemId, columnId: cols.intakePhotos },
          { dedupeKey: `intake-files:${itemId}:${i + 1}`, delayMs },
        ),
      );
    }

    await writeBack(claim, f);

    if (claim.email || claim.phone) {
      await services.notifier.ensureContact(claim);
      claim = repo.getClaim(itemId) ?? claim;
    }
    const reachable = !!claim.email || (!!claim.phone && claim.smsOptIn && !claim.smsOptedOut && ctx.config.SMS_ENABLED);
    if (reachable) {
      await services.notifier.notify(claim, 'confirmation', {}, { eventKey: `confirmation:${itemId}` });
      return;
    }
    // Nobody to tell yet. The first time, look again in a couple of minutes in
    // case the details arrive late (or the team is still filling the item in);
    // if they are still missing then, tell the team once.
    if (jobs.enqueue(JOB.mondayItemCreated, { itemId }, { dedupeKey: `intake-recheck:${itemId}`, delayMs: CONTACT_RECHECK_DELAY_MS })) {
      log.info({ itemId }, 'intake: no way to reach the claimant yet, re-checking later');
      return;
    }
    const note = claim.phone
      ? 'No email on this claim, and SMS is off or the claimant did not opt in — claimant was not notified.'
      : 'No email or phone on this claim — claimant was not notified.';
    await onceFor(ctx, `intake-unreachable:${itemId}`, () => monday.createUpdate(itemId, html`<p>${note}</p>`.value));
  }

  async function refreshClaim(itemId: string): Promise<Claim | null> {
    const claim = repo.getClaim(itemId);
    if (!claim) return null;
    const item = await fetchItem(itemId);
    if (!item || item.boardId !== board.claimsBoardId) return claim;
    return repo.updateClaim(itemId, patchFromFields(readClaimFields(board, item)));
  }

  return { handleItemCreated, refreshClaim };
}
