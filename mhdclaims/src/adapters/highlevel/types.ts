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

// Who a contact reaches: HighLevel sends email/SMS to the contact's own email and
// phone. An upsert reports the contact it matched or created, which may not be
// the one asked for: HighLevel matches an existing contact on email OR phone
// (the location's duplicate rule) and overwrites its other details.
export interface ContactIdentity {
  id: string;
  email: string | null;
  phone: string | null;
}

export interface ContactDetails {
  name?: string;
  firstName?: string;
  email?: string;
  phone?: string | null;
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
  // Creates or updates the contact (POST /contacts/upsert). Returns the contact
  // HighLevel matched or created, with the email and phone it has now. A null
  // email/phone in the input is not sent, so the contact keeps its own.
  upsertContact(input: ContactInput): Promise<ContactIdentity>;
  // The contact's current email and phone (GET /contacts/{id}); null if it no longer exists.
  getContact(contactId: string): Promise<ContactIdentity | null>;
  // Sets details on that one contact (PUT /contacts/{id}), with no duplicate
  // matching. Fields left undefined keep their value; phone null clears the number.
  updateContact(contactId: string, details: ContactDetails): Promise<void>;
  updateContactFields(contactId: string, customFields: Record<string, string>): Promise<void>;
  addTags(contactId: string, tags: string[]): Promise<void>;
  removeTags(contactId: string, tags: string[]): Promise<void>;
  sendEmail(input: SendEmailInput): Promise<{ messageId: string | null }>;
  sendSms(input: SendSmsInput): Promise<{ messageId: string | null }>;
  // Sends the settlement template (POST /proposals/templates/send) after writing
  // claim_number / settlement_amount to the contact's custom fields. The two ids
  // are both kept because HighLevel's identifier format is ambiguous. Never
  // retried here: when it throws, HighLevel may still have sent the document
  // (timeout, network error, 5xx), so the caller looks for it (findSentDocuments)
  // before sending again.
  requestSettlementSignature(req: SettlementRequest): Promise<SettlementDocumentRef>;
  // Checks the document via GET /proposals/document. Signed only when the status
  // is completed, it is not expired/deleted, and every signer (including this
  // contact) has hasCompleted + signedDate — staff can "Mark as Completed" in the
  // UI without signatures. The signed PDF is NOT available through the API.
  // sentAt (when the document was sent) narrows the list to a date window.
  verifySignedDocument(ref: SettlementDocumentRef, contactId: string, opts?: { sentAt?: string | null }): Promise<SignedDocumentCheck>;
  // Documents sent to this contact (recipients[].id) created at or after `since`,
  // other than the `exclude`d ones, oldest first (GET /proposals/document over a
  // dateFrom/dateTo window). Recovers the ids of a send whose response was lost.
  findSentDocuments(contactId: string, since: string, exclude?: SettlementDocumentRef[]): Promise<SentDocument[]>;
}

export interface SettlementDocumentRef {
  documentId: string | null;
  referenceId: string | null;
}

export interface SentDocument extends SettlementDocumentRef {
  createdAt: string | null;
  // The contact's own signing link (recipients[].shareLink), https only.
  signUrl: string | null;
}

export interface SignedDocumentCheck {
  signed: boolean;
  // Why not signed: 'not_found' | 'not_completed' | 'expired' | 'missing_signatures' | ...
  reason: string | null;
  signedAt: string | null;
  signerIp: string | null;
  documentName: string | null;
  // The contact's signing link (recipients[].shareLink, https only) when the
  // document was found and HighLevel gives one.
  signUrl?: string | null;
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
