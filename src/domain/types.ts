// Claimant-facing statuses. Board labels map onto these in config/board.json.
export const STATUS_KEYS = [
  'received',
  'under_review',
  'more_info_needed',
  'estimate_in_progress',
  'settlement_offered',
  'settlement_signed',
  'payment_sent',
  'closed',
  'denied',
] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

// A claim as the integration knows it. The Monday item is the record; this is
// the cached copy the portal reads from.
export interface Claim {
  itemId: string;
  claimNumber: string;
  claimantName: string;
  firstName: string;
  email: string | null;
  phone: string | null; // E.164 when known
  smsOptIn: boolean;
  // Texted STOP. HighLevel blocks SMS to them until they text START; we fall back to email.
  smsOptedOut: boolean;
  statusKey: StatusKey | null;
  statusLabel: string | null;
  amountClaimed: number | null;
  settlementAmount: number | null;
  highlevelContactId: string | null;
  // Bumped to revoke every outstanding portal link for the claim.
  tokenVersion: number;
  // Stage flags the portal uses to show settlement/payment steps.
  settlementSentAt: string | null;
  // Amount on the settlement document that was sent (may differ from the board if it changed since).
  settlementAmountSent: number | null;
  settlementSignedAt: string | null;
  paymentDetailsReceivedAt: string | null;
  receivedAt: string; // ISO timestamp
  updatedAt: string;
}

export type MessageDirection = 'to_claimant' | 'from_claimant' | 'system';
export type MessageChannel = 'portal' | 'email' | 'sms' | 'monday';

export interface ClaimMessage {
  id: number;
  itemId: string;
  direction: MessageDirection;
  // Where the message originated: a Monday update, the portal, an email/SMS reply,
  // or an automatic status notification ('system').
  channel: MessageChannel;
  body: string; // plain text
  mondayUpdateId: string | null;
  highlevelMessageId: string | null;
  createdAt: string;
}

export type FileSource = 'team' | 'claimant';

export interface ClaimFile {
  id: number;
  itemId: string;
  source: FileSource;
  columnId: string | null;
  mondayAssetId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  // Path relative to DATA_DIR/files.
  storageKey: string;
  createdAt: string;
}

// Template slots the team can edit. Status templates are keyed by StatusKey;
// the rest are fixed events.
export const EVENT_TEMPLATE_KEYS = ['confirmation', 'new_message', 'login_code', 'claim_links', 'status_reply'] as const;
export type EventTemplateKey = (typeof EVENT_TEMPLATE_KEYS)[number];
export type TemplateKey = StatusKey | EventTemplateKey;

export interface MessageTemplate {
  key: TemplateKey;
  emailSubject: string;
  emailBody: string; // plain text with {{vars}}; rendered to simple HTML
  sms: string; // empty = no SMS for this event
  portalText: string; // "what happens next" shown on the claim page (status keys only)
}

// Variables available to every template. Missing values render as ''.
export interface TemplateVars {
  firstName: string;
  claimantName: string;
  claimNumber: string;
  portalUrl: string;
  statusLabel: string;
  dateReceived: string;
  amountClaimed: string;
  settlementAmount: string;
  paymentFormUrl: string;
  message: string;
  code: string;
  claimList: string;
}
