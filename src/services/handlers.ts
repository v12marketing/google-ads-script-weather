import type { HighLevelEvent } from '../adapters/highlevel/types.js';
import type { MondayEvent } from '../adapters/monday/types.js';
import { JOB, type AppContext } from './contracts.js';

// Job type -> service call. Payloads are the normalised webhook events (or ids)
// the routes enqueue.
export function registerJobHandlers(ctx: AppContext): void {
  const { jobs, services: s } = ctx;

  jobs.register(JOB.mondayItemCreated, (p: { itemId: string }) => s.intake.handleItemCreated(p.itemId));

  jobs.register(JOB.mondayStatusChanged, (p: { itemId: string; label: string | null; eventId?: string }) =>
    s.status.handleStatusChanged(p.itemId, p.label, p.eventId),
  );

  jobs.register(JOB.mondayColumnChanged, async (p: { itemId: string; columnId: string }) => {
    // File columns re-sync the portal copy; other columns refresh the cached claim.
    await s.intake.refreshClaim(p.itemId);
    await s.files.syncFiles(p.itemId);
  });

  jobs.register(JOB.mondayUpdateCreated, (p: Extract<MondayEvent, { kind: 'update_created' }>) =>
    s.messaging.handleMondayUpdate(p),
  );

  jobs.register(JOB.paymentItemCreated, (p: { itemId: string }) => s.payment.handlePaymentItemCreated(p.itemId));

  jobs.register(JOB.highlevelInbound, (p: Extract<HighLevelEvent, { kind: 'inbound_message' }>) =>
    s.messaging.handleInbound(p),
  );

  jobs.register(JOB.portalMessageToMonday, (p: { messageId: number }) => s.messaging.deliverPortalMessage(p.messageId));

  jobs.register(JOB.uploadToMonday, (p: { fileId: number }) => s.files.attachUploadToMonday(p.fileId));

  jobs.register(JOB.highlevelDocumentSigned, (p: Extract<HighLevelEvent, { kind: 'document_signed' }>) =>
    s.settlement.handleDocumentSigned(p),
  );

  jobs.register(JOB.highlevelDocumentDeclined, (p: Extract<HighLevelEvent, { kind: 'document_declined' }>) =>
    s.settlement.handleDocumentDeclined(p),
  );

  jobs.register(JOB.settlementReconcile, () => s.settlement.reconcilePending());
}
