// The slice of the HighLevel (LeadConnector) API the integration uses: contacts,
// email/SMS sending, and the settlement e-signature. fake.ts records calls for tests.

export interface ContactInput {
  name: string;
  firstName: string;
  email: string | null;
  phone: string | null;
  smsOptIn: boolean;
  tags?: string[];
  // Contact custom field values keyed by our names (claim_number, settlement_amount,
  // portal_url, ...). The client maps them to HighLevel custom field ids.
  customFields?: Record<string, string>;
}

export interface SendEmailInput {
  contactId: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendSmsInput {
  contactId: string;
  message: string;
}

export interface SettlementRequest {
  contactId: string;
  claimNumber: string;
  itemId: string;
  settlementAmount: number;
  claimantName: string;
  portalUrl: string;
}

export interface HighLevelApi {
  // Creates or updates the contact; returns the contact id.
  upsertContact(input: ContactInput): Promise<string>;
  updateContactFields(contactId: string, customFields: Record<string, string>): Promise<void>;
  addTags(contactId: string, tags: string[]): Promise<void>;
  removeTags(contactId: string, tags: string[]): Promise<void>;
  sendEmail(input: SendEmailInput): Promise<{ messageId: string | null }>;
  sendSms(input: SendSmsInput): Promise<{ messageId: string | null }>;
  // Starts the e-signature of the settlement document. Returns a reference to the
  // document when the API gives one; completion arrives as a webhook.
  requestSettlementSignature(req: SettlementRequest): Promise<{ documentId: string | null }>;
  // Downloads the signed document as PDF.
  downloadSignedDocument(documentId: string): Promise<{ data: Buffer; name: string }>;
}

// Normalised inbound events from HighLevel webhooks.
export type HighLevelEvent =
  | {
      kind: 'inbound_message';
      contactId: string;
      channel: 'sms' | 'email';
      body: string;
      messageId: string | null;
      // Email subject when channel = email.
      subject: string | null;
    }
  | {
      kind: 'document_signed';
      contactId: string | null;
      documentId: string;
      // Claim number recovered from the document / contact custom field, if present.
      claimNumber: string | null;
    };
