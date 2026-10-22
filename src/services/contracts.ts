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
  notify(claim: Claim, key: TemplateKey, extra?: Partial<TemplateVars>): Promise<NotifyResult>;
  // Sends one SMS outside the template system (STATUS replies).
  sendSms(claim: Claim, text: string): Promise<boolean>;
  // Creates/updates the HighLevel contact for the claim and stores its id.
  ensureContact(claim: Claim): Promise<string>;
}

export interface IntakeService {
  // New item on the claims board: assign claim number, write it back, contact, confirmation.
  handleItemCreated(itemId: string): Promise<void>;
  // Refreshes the cached claim from the board (contact fields, status, amounts).
  refreshClaim(itemId: string): Promise<Claim | null>;
}

export interface StatusService {
  handleStatusChanged(itemId: string, label: string | null): Promise<void>;
}

export interface SettlementService {
  sendSettlement(claim: Claim): Promise<void>;
  handleDocumentSigned(event: Extract<HighLevelEvent, { kind: 'document_signed' }>): Promise<void>;
}

export interface PaymentService {
  paymentFormUrl(claim: Claim): string;
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

export interface AuthService {
  // Device trust for the portal (one-time code to the claim's email).
  isDeviceTrusted(claim: Claim, deviceId: string | undefined): boolean;
  // Sends a code; returns false if rate-limited. deviceId binds the code to this browser.
  sendLoginCode(claim: Claim, deviceId: string): Promise<{ sent: boolean; maskedEmail: string }>;
  verifyLoginCode(claim: Claim, deviceId: string, code: string, userAgent?: string): 'ok' | 'invalid' | 'expired' | 'locked';
  newDeviceId(): string;
  csrfToken(deviceId: string, itemId: string): string;
  checkCsrf(deviceId: string, itemId: string, token: string | undefined): boolean;
  // "Find my claim": emails links for every claim on the address. Always resolves
  // the same way whether or not the email is known.
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
