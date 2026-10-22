import type { ContactInput, HighLevelApi, SendEmailInput, SendSmsInput, SettlementRequest, SignedDocumentCheck } from './types.js';

// Records everything sent through HighLevel so tests can assert on it.
export class FakeHighLevel implements HighLevelApi {
  contacts = new Map<string, ContactInput & { id: string; tags: string[]; customFields: Record<string, string> }>();
  emails: SendEmailInput[] = [];
  sms: SendSmsInput[] = [];
  settlementRequests: SettlementRequest[] = [];
  // documentId -> state; tests flip `signed` to simulate the claimant signing.
  documents = new Map<string, { contactId: string; signed: boolean; signedAt: string | null }>();
  calls: Array<{ method: string; args: unknown[] }> = [];
  failNext = 0;
  private nextId = 1;

  private maybeFail(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`FakeHighLevel: simulated failure in ${method}`);
    }
  }

  async upsertContact(input: ContactInput): Promise<string> {
    this.maybeFail('upsertContact', [input]);
    // Same email or phone -> same contact, like HighLevel's duplicate rules.
    for (const c of this.contacts.values()) {
      if ((input.email && c.email?.toLowerCase() === input.email.toLowerCase()) || (input.phone && c.phone === input.phone)) {
        Object.assign(c, { ...input, tags: [...new Set([...c.tags, ...(input.tags ?? [])])], customFields: { ...c.customFields, ...input.customFields } });
        return c.id;
      }
    }
    const id = `contact_${this.nextId++}`;
    this.contacts.set(id, { ...input, id, tags: input.tags ?? [], customFields: input.customFields ?? {} });
    return id;
  }

  async updateContactFields(contactId: string, customFields: Record<string, string>): Promise<void> {
    this.maybeFail('updateContactFields', [contactId, customFields]);
    const c = this.contacts.get(contactId);
    if (c) Object.assign(c.customFields, customFields);
  }

  async addTags(contactId: string, tags: string[]): Promise<void> {
    this.maybeFail('addTags', [contactId, tags]);
    const c = this.contacts.get(contactId);
    if (c) c.tags = [...new Set([...c.tags, ...tags])];
  }

  async removeTags(contactId: string, tags: string[]): Promise<void> {
    this.maybeFail('removeTags', [contactId, tags]);
    const c = this.contacts.get(contactId);
    if (c) c.tags = c.tags.filter((t) => !tags.includes(t));
  }

  async sendEmail(input: SendEmailInput): Promise<{ messageId: string | null }> {
    this.maybeFail('sendEmail', [input]);
    this.emails.push(input);
    return { messageId: `msg_${this.nextId++}` };
  }

  async sendSms(input: SendSmsInput): Promise<{ messageId: string | null }> {
    this.maybeFail('sendSms', [input]);
    this.sms.push(input);
    return { messageId: `msg_${this.nextId++}` };
  }

  async requestSettlementSignature(req: SettlementRequest): Promise<{ documentId: string | null; referenceId: string | null }> {
    this.maybeFail('requestSettlementSignature', [req]);
    this.settlementRequests.push(req);
    const documentId = `doc_${this.nextId++}`;
    this.documents.set(documentId, { contactId: req.contactId, signed: false, signedAt: null });
    return { documentId, referenceId: `ref_${documentId}` };
  }

  // Test helper: the claimant signs the most recent document sent to them.
  sign(documentId?: string): string {
    const id = documentId ?? [...this.documents.keys()].pop();
    const d = id ? this.documents.get(id) : undefined;
    if (!id || !d) throw new Error('FakeHighLevel: no document to sign');
    d.signed = true;
    d.signedAt = new Date().toISOString();
    return id;
  }

  async verifySignedDocument(
    ref: { documentId: string | null; referenceId: string | null },
    contactId: string,
  ): Promise<SignedDocumentCheck> {
    this.maybeFail('verifySignedDocument', [ref, contactId]);
    const id = ref.documentId ?? ref.referenceId?.replace(/^ref_/, '') ?? '';
    const d = this.documents.get(id);
    if (!d) return { signed: false, reason: 'not_found', signedAt: null, signerIp: null, documentName: null };
    if (d.contactId !== contactId) return { signed: false, reason: 'wrong_signer', signedAt: null, signerIp: null, documentName: null };
    if (!d.signed) return { signed: false, reason: 'not_completed', signedAt: null, signerIp: null, documentName: null };
    return { signed: true, reason: null, signedAt: d.signedAt, signerIp: '203.0.113.7', documentName: 'Settlement Agreement' };
  }
}
