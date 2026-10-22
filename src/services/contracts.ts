import type { AppConfig } from '../config.js';
import type { BoardConfig } from '../board-config.js';
import type { Db } from '../db/index.js';
import type { Repo } from '../db/repo.js';
import type { HighLevelApi, HighLevelEvent } from '../adapters/highlevel/types.js';
import type { MondayApi, MondayEvent } from '../adapters/monday/types.js';
import type { Claim, ClaimFile, ClaimMessage, MessageTemplate, TemplateKey, TemplateVars } from '../domain/types.js';
import type { FileStore } from './storage.js';
import type { JobQueue, Logger } from './jobs.js';

// Everything the services share. Built once in context.ts.
export interface CoreContext {
  config: AppConfig;
  board: BoardConfig;
  db: Db;
  repo: Repo;
  jobs: JobQueue;
  monday: MondayApi;
  highlevel: HighLevelApi;
  store: FileStore;
  log: Logger;
}

// Job type names. Webhook routes enqueue these; services register handlers.
export const JOB = {
  mondayItemCreated: 'monday.item_created',
  mondayStatusChanged: 'monday.status_changed',
  mondayColumnChanged: 'monday.column_changed',
  mondayUpdateCreated: 'monday.update_created',
  paymentItemCreated: 'payment.item_created',
  highlevelInbound: 'highlevel.inbound_message',
  highlevelDocumentSigned: 'highlevel.document_signed',
  highlevelDocumentDeclined: 'highlevel.document_declined',
  // Every 15 minutes: re-check settlements sent but not signed, in case a webhook was missed.
  settlementReconcile: 'settlement.reconcile',
  // Claimant wrote on the portal: post it to Monday and notify the team.
  portalMessageToMonday: 'claim.portal_message_to_monday',
  // Claimant uploaded on the portal: attach it to the Monday file column.
  uploadToMonday: 'claim.upload_to_monday',
} as const;

export interface TokenService {
  // The secret in a claim's private link. Derived, so every email can carry it
  // without storing it; bumping tokenVersion revokes old links.
  portalToken(itemId: string, tokenVersion: number): string;
  tokenHash(token: string): string;
  portalUrl(claim: Pick<Claim, 'itemId' | 'tokenVersion'>): string;
  // Looks up the claim a link token belongs to; null if unknown or revoked.
  claimForToken(token: string): Claim | null;
}

export interface TemplateService {
  get(key: TemplateKey): MessageTemplate; // override if saved, else default
  getDefault(key: TemplateKey): MessageTemplate;
  save(t: MessageTemplate, updatedBy: string): void;
  reset(key: TemplateKey): void;
  vars(claim: Claim, extra?: Partial<TemplateVars>): TemplateVars;
  // Substitutes {{var}} placeholders. Unknown placeholders render as ''.
  render(text: string, vars: TemplateVars): string;
}

export interface NotifyResult {
  emailSent: boolean;
  smsSent: boolean;
}

export interface Notifier {
  // Sends the template's email (and SMS if opted in, enabled, and the template
  // has SMS text) to the claimant. Ensures the HighLevel contact exists.
  // Pass eventKey to make retries safe: a channel already sent for that key is
  // skipped (recorded via repo.markEventProcessed after each successful send).
  // Before sending, the contact is re-read from HighLevel: email goes only to a
  // contact whose email is claim.email, SMS only to one whose phone is
  // claim.phone (else the SMS is skipped). Throws ContactConflictError (a
  // PermanentJobError) when no such contact can be had; nothing is sent then.
  notify(claim: Claim, key: TemplateKey, extra?: Partial<TemplateVars>, opts?: { eventKey?: string }): Promise<NotifyResult>;
  // Sends one SMS outside the template system (STATUS replies). False when not
  // allowed, or the contact's phone isn't the claim's.
  sendSms(claim: Claim, text: string): Promise<boolean>;
  // Creates/updates the HighLevel contact for the claim and stores its id. Only
  // ever stores a contact whose email is claim.email (no email: a contact without
  // one), and never rewrites the email of a contact another claim uses with a
  // different email: the phone is left off the upsert when it conflicts (texts
  // are then off for the claim, and the team is told once). Throws
  // ContactConflictError, after telling the team on the item, when HighLevel
  // can't give such a contact.
  ensureContact(claim: Claim): Promise<string>;
}

export interface IntakeService {
  // New item on the claims board: assign claim number, write it back, contact,
  // confirmation. Resumable: a retry or redelivery finishes whatever an earlier
  // run didn't (each step is idempotent), and refreshClaim does too.
  handleItemCreated(itemId: string): Promise<void>;
  // Refreshes the cached claim from the board (contact fields, status, amounts).
  // Finishes an intake that didn't complete. When the email or phone changed, the
  // HighLevel contact is synced again, and a changed email forgets the browsers
  // trusted for the claim.
  refreshClaim(itemId: string): Promise<Claim | null>;
}

export interface StatusService {
  // eventId (Monday triggerUuid) dedupes redeliveries while still allowing the
  // same status to be set again later (e.g. a second "More info needed").
  handleStatusChanged(itemId: string, label: string | null, eventId?: string): Promise<void>;
}

export interface SettlementService {
  // Status moved to settlement_offered: send the document for e-signature.
  sendSettlement(claim: Claim): Promise<void>;
  // Workflow webhook said a document completed: verify via the API, then mark the
  // claim signed and move the board to the settlement-signed label.
  handleDocumentSigned(event: Extract<HighLevelEvent, { kind: 'document_signed' }>): Promise<void>;
  handleDocumentDeclined(event: Extract<HighLevelEvent, { kind: 'document_declined' }>): Promise<void>;
  reconcilePending(): Promise<void>;
}

export interface PaymentService {
  // Payment WorkForm link pre-filled with the claim number and its HMAC signature.
  paymentFormUrl(claim: Claim): string;
  // HMAC of the claim number and the claim's tokenVersion (default: the current
  // one of the claim with that number), so replacing the claim link also
  // revokes the payment form link sent before.
  paymentSignature(claimNumber: string, tokenVersion?: number): string;
  // New item on the payment board: reads ONLY the claim-number and signature
  // columns, labels the item verified/mismatch/duplicate (a second verified
  // submission for a claim), and marks the claim's payment step. While either
  // column is empty it re-checks later (create_item can beat the form answers).
  handlePaymentItemCreated(itemId: string): Promise<void>;
}

export interface MessagingService {
  // Monday update on a claim item. Sent to the claimant if it carries the prefix.
  handleMondayUpdate(event: Extract<MondayEvent, { kind: 'update_created' }>): Promise<void>;
  // Claimant posted on the portal. Recorded at once; Monday post happens in a job.
  postFromPortal(claim: Claim, text: string): ClaimMessage;
  // Job body for postFromPortal: posts the message as an update and notifies the team.
  deliverPortalMessage(messageId: number): Promise<void>;
  // Inbound SMS/email reply via HighLevel, including the STATUS keyword.
  handleInbound(event: Extract<HighLevelEvent, { kind: 'inbound_message' }>): Promise<void>;
}

export interface FileService {
  // Mirrors the shared/claimant-visible file columns of the item into the cache.
  syncFiles(itemId: string): Promise<void>;
  // Claimant upload from the portal. Stored at once; attached to Monday in a job.
  addClaimantUpload(claim: Claim, file: { name: string; mimeType: string; data: Buffer }): Promise<ClaimFile>;
  // Job body for addClaimantUpload: attaches the file to the claimant-uploads column.
  attachUploadToMonday(fileId: number): Promise<void>;
  read(file: ClaimFile): Promise<Buffer>;
}

export interface LoginCodeResult {
  sent: boolean;
  maskedEmail: string;
  // Set when rate-limited:
  // 'device': this browser asked for several codes in the last 15 minutes; the
  //   most recent one emailed for it still works, or it can ask again after that.
  // 'claim': the claim's daily allowance (all browsers together) is used up; no
  //   new code until the oldest of today's requests is a day old.
  limited?: 'device' | 'claim';
}

// 'other_device': this browser has no usable code, but another browser has a
// live one for the claim (it was asked for there): enter it there, or ask here.
export type LoginCodeCheck = 'ok' | 'invalid' | 'expired' | 'locked' | 'other_device';

export interface AuthService {
  // Device trust for the portal (one-time code to the claim's email).
  isDeviceTrusted(claim: Claim, deviceId: string | undefined): boolean;
  // Sends a code; returns sent=false if rate-limited (`limited` says which limit)
  // or the claim has no email. deviceId binds the code to this browser. Throws
  // when the email can't be delivered; the code is discarded first, so it
  // neither works nor counts. ContactConflictError (notifier.ts) means it can't
  // be sent at all until the team fixes the claim's contact (they've been told).
  sendLoginCode(claim: Claim, deviceId: string): Promise<LoginCodeResult>;
  verifyLoginCode(claim: Claim, deviceId: string, code: string, userAgent?: string): LoginCodeCheck;
  newDeviceId(): string;
  csrfToken(deviceId: string, itemId: string): string;
  checkCsrf(deviceId: string, itemId: string, token: string | undefined): boolean;
  // "Find my claim": emails links for every claim on the address. Always resolves
  // the same way whether or not the email is known, and before the email is
  // delivered (it is sent in the background; failures are logged), so response
  // time reveals nothing. In-process fakes have sent it by the time it resolves.
  sendClaimLinks(email: string): Promise<void>;
}

export interface Services {
  tokens: TokenService;
  templates: TemplateService;
  notifier: Notifier;
  intake: IntakeService;
  status: StatusService;
  settlement: SettlementService;
  payment: PaymentService;
  messaging: MessagingService;
  files: FileService;
  auth: AuthService;
}

export type AppContext = CoreContext & { services: Services };
