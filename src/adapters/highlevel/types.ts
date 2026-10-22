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
  // Sends the settlement template (POST /proposals/templates/send) after writing
  // claim_number / settlement_amount to the contact's custom fields. The two ids
  // are both kept because HighLevel's identifier format is ambiguous.
  requestSettlementSignature(req: SettlementRequest): Promise<{ documentId: string | null; referenceId: string | null }>;
  // Checks the document via GET /proposals/document. Signed only when the status
  // is completed, it is not expired/deleted, and every signer (including this
  // contact) has hasCompleted + signedDate — staff can "Mark as Completed" in the
  // UI without signatures. The signed PDF is NOT available through the API.
  verifySignedDocument(
    ref: { documentId: string | null; referenceId: string | null },
    contactId: string,
  ): Promise<SignedDocumentCheck>;
}

export interface SignedDocumentCheck {
  signed: boolean;
  // Why not signed: 'not_found' | 'not_completed' | 'expired' | 'missing_signatures' | ...
  reason: string | null;
  signedAt: string | null;
  signerIp: string | null;
  documentName: string | null;
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
      // From the "Documents & Contracts: Completed" workflow's Webhook action, which
      // carries contact data, not the document; the service verifies via the API.
      kind: 'document_signed';
      contactId: string | null;
      documentId: string | null;
      claimNumber: string | null;
    }
  | {
      kind: 'document_declined';
      contactId: string | null;
      claimNumber: string | null;
    };
