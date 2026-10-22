import type { MondayItem } from '../adapters/monday/types.js';
import { statusKeyForLabel } from '../board-config.js';
import { nowIso } from '../db/index.js';
import type { ClaimPatch } from '../db/repo.js';
import type { Claim } from '../domain/types.js';
import { html } from '../web/html.js';
import { addSystemMessageOnce, businessDate, claimColumnIds, onceFor, readClaimFields, type ClaimFields } from './claim-fields.js';
import { JOB, type CoreContext, type IntakeService, type Services } from './contracts.js';
import { ContactConflictError } from './notifier.js';

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
    // The date the claimant is told (and the portal shows), not the UTC date.
    const date = businessDate(claim.receivedAt);
    if (cols.dateReceived && f.dateReceived !== date) values[cols.dateReceived] = { date };
    if (cols.portalLink) {
      const link = services.tokens.portalUrl(claim);
      if (f.portalLink !== link) values[cols.portalLink] = link;
    }
    if (Object.keys(values).length) await monday.changeColumnValues(board.claimsBoardId, claim.itemId, values);
  }

  // Set once the claimant has been sent the confirmation (or the team told there's
  // no way to reach them). Claims from before this key existed count as done once
  // either of those happened.
  const doneKey = (itemId: string): string => `intake-done:${itemId}`;
  const intakeDone = (itemId: string): boolean =>
    [doneKey(itemId), `sent:confirmation:${itemId}:email`, `sent:confirmation:${itemId}:sms`, `intake-unreachable:${itemId}`].some((k) =>
      repo.isEventProcessed(k),
    );

  // Caches the board's fields. A changed email forgets the browsers trusted for
  // the claim: they proved they could read the old address, not the new one.
  function applyFields(before: Claim, f: ClaimFields): { claim: Claim; contactChanged: boolean } {
    const emailChanged = (before.email?.trim().toLowerCase() || null) !== (f.email?.trim().toLowerCase() || null);
    const contactChanged = emailChanged || (before.phone || null) !== (f.phone || null);
    const claim = ctx.db.transaction(() => {
      const updated = repo.updateClaim(before.itemId, patchFromFields(f)) ?? before;
      if (emailChanged && repo.deleteDevices(before.itemId) > 0) {
        log.info({ itemId: before.itemId }, 'intake: claim email changed; trusted browsers must verify again');
      }
      return updated;
    })();
    return { claim, contactChanged };
  }

  // False when no HighLevel contact can safely be used (the notifier has told the team).
  async function contactReady(claim: Claim): Promise<boolean> {
    try {
      await services.notifier.ensureContact(claim);
      return true;
    } catch (err) {
      if (err instanceof ContactConflictError) return false;
      throw err;
    }
  }

  // Write-back, contact and confirmation. Each step is idempotent, so a retry or
  // a later refresh picks up wherever an earlier run stopped.
  async function finishIntake(claim: Claim, f: ClaimFields, from: 'intake' | 'refresh'): Promise<void> {
    const itemId = claim.itemId;
    await writeBack(claim, f);

    if (claim.email || claim.phone) {
      // On a conflict the team has been told; the confirmation goes out on a
      // later run once the details are fixed.
      if (!(await contactReady(claim))) return;
      claim = repo.getClaim(itemId) ?? claim;
    }
    const reachable = !!claim.email || (!!claim.phone && claim.smsOptIn && !claim.smsOptedOut && ctx.config.SMS_ENABLED);
    if (reachable) {
      try {
        await services.notifier.notify(claim, 'confirmation', {}, { eventKey: `confirmation:${itemId}` });
      } catch (err) {
        if (err instanceof ContactConflictError) return;
        throw err;
      }
      repo.markEventProcessed(doneKey(itemId));
      return;
    }
    // Nobody to tell yet. The first time, look again in a couple of minutes in
    // case the details arrive late (or the team is still filling the item in);
    // if they are still missing then, tell the team once.
    if (jobs.enqueue(JOB.mondayItemCreated, { itemId }, { dedupeKey: `intake-recheck:${itemId}`, delayMs: CONTACT_RECHECK_DELAY_MS })) {
      log.info({ itemId }, 'intake: no way to reach the claimant yet, re-checking later');
      return;
    }
    // The re-check job tells the team; a refresh in the meantime must not cut it short.
    if (from === 'refresh') return;
    const note = claim.phone
      ? 'No email on this claim, and SMS is off or the claimant did not opt in — claimant was not notified.'
      : 'No email or phone on this claim — claimant was not notified.';
    await onceFor(ctx, `intake-unreachable:${itemId}`, (once) => monday.createUpdate(itemId, html`<p>${note}</p>`.value, once));
    repo.markEventProcessed(doneKey(itemId));
  }

  // After caching the board's fields: finish an intake that didn't complete, or
  // re-sync the contact when the claimant's email or phone changed.
  async function afterFields(claim: Claim, f: ClaimFields, contactChanged: boolean, from: 'intake' | 'refresh'): Promise<void> {
    if (!intakeDone(claim.itemId)) await finishIntake(claim, f, from);
    else if (contactChanged && (claim.email || claim.phone)) await contactReady(claim);
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
        // Kept if the item already has one no other claim uses (e.g. after a
        // restore), so the claimant's number doesn't change under them.
        claimNumber: f.claimNumber,
      },
      (id, version) => services.tokens.tokenHash(services.tokens.portalToken(id, version)),
    );
    // A redelivery or retry picks up wherever the last run stopped; every step below is idempotent.
    const { claim, contactChanged } = applyFields(created, f);
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

    await afterFields(claim, f, contactChanged, 'intake');
  }

  async function refreshClaim(itemId: string): Promise<Claim | null> {
    const before = repo.getClaim(itemId);
    if (!before) return null;
    const item = await fetchItem(itemId);
    if (!item || item.boardId !== board.claimsBoardId) return before;
    const f = readClaimFields(board, item);
    const { claim, contactChanged } = applyFields(before, f);
    // Also finishes an intake that stopped partway, e.g. one run inside a status
    // job that failed and is being retried (the claim row exists by then).
    await afterFields(claim, f, contactChanged, 'refresh');
    return repo.getClaim(itemId) ?? claim;
  }

  return { handleItemCreated, refreshClaim };
}
