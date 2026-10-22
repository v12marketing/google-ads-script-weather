import type { Db } from './index.js';
import { nowIso } from './index.js';
import type {
  Claim,
  ClaimFile,
  ClaimMessage,
  FileSource,
  MessageChannel,
  MessageDirection,
  MessageTemplate,
  StatusKey,
  TemplateKey,
} from '../domain/types.js';

// Typed access to the cache tables. Services never write SQL directly.

interface ClaimRow {
  item_id: string;
  claim_number: string;
  seq: number;
  claimant_name: string;
  first_name: string;
  email: string | null;
  phone: string | null;
  sms_opt_in: number;
  sms_opted_out: number;
  status_key: string | null;
  status_label: string | null;
  amount_claimed: number | null;
  settlement_amount: number | null;
  highlevel_contact_id: string | null;
  token_version: number;
  token_hash: string;
  settlement_sent_at: string | null;
  settlement_document_id: string | null;
  settlement_reference_id: string | null;
  settlement_amount_sent: number | null;
  settlement_signed_at: string | null;
  payment_details_received_at: string | null;
  received_at: string;
  updated_at: string;
}

const toClaim = (r: ClaimRow): Claim => ({
  itemId: r.item_id,
  claimNumber: r.claim_number,
  claimantName: r.claimant_name,
  firstName: r.first_name,
  email: r.email,
  phone: r.phone,
  smsOptIn: r.sms_opt_in === 1,
  smsOptedOut: r.sms_opted_out === 1,
  statusKey: r.status_key as StatusKey | null,
  statusLabel: r.status_label,
  amountClaimed: r.amount_claimed,
  settlementAmount: r.settlement_amount,
  highlevelContactId: r.highlevel_contact_id,
  tokenVersion: r.token_version,
  settlementSentAt: r.settlement_sent_at,
  settlementAmountSent: r.settlement_amount_sent,
  settlementSignedAt: r.settlement_signed_at,
  paymentDetailsReceivedAt: r.payment_details_received_at,
  receivedAt: r.received_at,
  updatedAt: r.updated_at,
});

export interface NewClaim {
  itemId: string;
  claimantName: string;
  firstName: string;
  email: string | null;
  phone: string | null;
  smsOptIn: boolean;
  statusKey: StatusKey | null;
  statusLabel: string | null;
  amountClaimed: number | null;
  receivedAt: string;
}

export type ClaimPatch = Partial<{
  claimantName: string;
  firstName: string;
  email: string | null;
  phone: string | null;
  smsOptIn: boolean;
  smsOptedOut: boolean;
  statusKey: StatusKey | null;
  statusLabel: string | null;
  amountClaimed: number | null;
  settlementAmount: number | null;
  highlevelContactId: string | null;
  tokenVersion: number;
  tokenHash: string;
  settlementSentAt: string | null;
  settlementDocumentId: string | null;
  settlementReferenceId: string | null;
  settlementAmountSent: number | null;
  settlementSignedAt: string | null;
  paymentDetailsReceivedAt: string | null;
}>;

const PATCH_COLUMNS: Record<keyof ClaimPatch, string> = {
  claimantName: 'claimant_name',
  firstName: 'first_name',
  email: 'email',
  phone: 'phone',
  smsOptIn: 'sms_opt_in',
  smsOptedOut: 'sms_opted_out',
  statusKey: 'status_key',
  statusLabel: 'status_label',
  amountClaimed: 'amount_claimed',
  settlementAmount: 'settlement_amount',
  highlevelContactId: 'highlevel_contact_id',
  tokenVersion: 'token_version',
  tokenHash: 'token_hash',
  settlementSentAt: 'settlement_sent_at',
  settlementDocumentId: 'settlement_document_id',
  settlementReferenceId: 'settlement_reference_id',
  settlementAmountSent: 'settlement_amount_sent',
  settlementSignedAt: 'settlement_signed_at',
  paymentDetailsReceivedAt: 'payment_details_received_at',
};

export const formatClaimNumber = (seq: number): string => `HDC-${String(seq).padStart(6, '0')}`;

export class Repo {
  constructor(readonly db: Db) {}

  // --- claims ---

  getClaim(itemId: string): Claim | null {
    const r = this.db.prepare('SELECT * FROM claims WHERE item_id = ?').get(itemId) as ClaimRow | undefined;
    return r ? toClaim(r) : null;
  }

  getClaimByNumber(claimNumber: string): Claim | null {
    const r = this.db.prepare('SELECT * FROM claims WHERE claim_number = ?').get(claimNumber.trim().toUpperCase()) as
      | ClaimRow
      | undefined;
    return r ? toClaim(r) : null;
  }

  getClaimByTokenHash(tokenHash: string): Claim | null {
    const r = this.db.prepare('SELECT * FROM claims WHERE token_hash = ?').get(tokenHash) as ClaimRow | undefined;
    return r ? toClaim(r) : null;
  }

  getSettlementRefs(itemId: string): { documentId: string | null; referenceId: string | null } {
    const r = this.db
      .prepare('SELECT settlement_document_id d, settlement_reference_id r FROM claims WHERE item_id = ?')
      .get(itemId) as { d: string | null; r: string | null } | undefined;
    return { documentId: r?.d ?? null, referenceId: r?.r ?? null };
  }

  getClaimBySettlementDocument(documentId: string): Claim | null {
    const r = this.db
      .prepare('SELECT * FROM claims WHERE settlement_document_id = ? OR settlement_reference_id = ?')
      .get(documentId, documentId) as ClaimRow | undefined;
    return r ? toClaim(r) : null;
  }

  // Settlement sent but not yet signed, for the reconciliation poller.
  listClaimsAwaitingSignature(): Claim[] {
    const rows = this.db
      .prepare('SELECT * FROM claims WHERE settlement_sent_at IS NOT NULL AND settlement_signed_at IS NULL')
      .all() as ClaimRow[];
    return rows.map(toClaim);
  }

  // Most recently received first.
  findClaimsByEmail(email: string): Claim[] {
    const rows = this.db
      .prepare('SELECT * FROM claims WHERE lower(email) = lower(?) ORDER BY received_at DESC')
      .all(email.trim()) as ClaimRow[];
    return rows.map(toClaim);
  }

  // Most recently received first.
  findClaimsByContact(contactId: string): Claim[] {
    const rows = this.db
      .prepare('SELECT * FROM claims WHERE highlevel_contact_id = ? ORDER BY received_at DESC')
      .all(contactId) as ClaimRow[];
    return rows.map(toClaim);
  }

  // Allocates the next claim number and inserts the claim atomically. If the item
  // already has a claim (webhook redelivered), returns the existing one unchanged.
  createClaim(input: NewClaim, tokenHashFor: (itemId: string, tokenVersion: number) => string): { claim: Claim; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.getClaim(input.itemId);
      if (existing) return { claim: existing, created: false };
      const seq = (this.db.prepare('UPDATE claim_number_seq SET last = last + 1 WHERE id = 1 RETURNING last').get() as {
        last: number;
      }).last;
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO claims (item_id, claim_number, seq, claimant_name, first_name, email, phone, sms_opt_in,
             status_key, status_label, amount_claimed, token_version, token_hash, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          input.itemId,
          formatClaimNumber(seq),
          seq,
          input.claimantName,
          input.firstName,
          input.email,
          input.phone,
          input.smsOptIn ? 1 : 0,
          input.statusKey,
          input.statusLabel,
          input.amountClaimed,
          tokenHashFor(input.itemId, 1),
          input.receivedAt,
          now,
        );
      return { claim: this.getClaim(input.itemId)!, created: true };
    })();
  }

  // Replaces the claim's private link: bumps tokenVersion, stores the new link's
  // hash and forgets every trusted browser, atomically.
  rotatePortalToken(itemId: string, tokenHashFor: (itemId: string, tokenVersion: number) => string): Claim | null {
    return this.db.transaction(() => {
      const c = this.getClaim(itemId);
      if (!c) return null;
      const tokenVersion = c.tokenVersion + 1;
      this.db.prepare('DELETE FROM devices WHERE item_id = ?').run(itemId);
      return this.updateClaim(itemId, { tokenVersion, tokenHash: tokenHashFor(itemId, tokenVersion) });
    })();
  }

  updateClaim(itemId: string, patch: ClaimPatch): Claim | null {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch) as Array<[keyof ClaimPatch, unknown]>) {
      if (v === undefined) continue;
      sets.push(`${PATCH_COLUMNS[k]} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      vals.push(nowIso(), itemId);
      this.db.prepare(`UPDATE claims SET ${sets.join(', ')} WHERE item_id = ?`).run(...vals);
    }
    return this.getClaim(itemId);
  }

  // --- messages ---

  // Returns null when the message was already recorded (same Monday update or
  // HighLevel message id), so callers can skip re-sending.
  addMessage(m: {
    itemId: string;
    direction: MessageDirection;
    channel: MessageChannel;
    body: string;
    mondayUpdateId?: string | null;
    highlevelMessageId?: string | null;
    createdAt?: string;
  }): ClaimMessage | null {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (item_id, direction, channel, body, monday_update_id, highlevel_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.itemId, m.direction, m.channel, m.body, m.mondayUpdateId ?? null, m.highlevelMessageId ?? null, m.createdAt ?? nowIso());
    if (res.changes === 0) return null;
    return this.getMessage(Number(res.lastInsertRowid));
  }

  setMessageMondayUpdateId(id: number, mondayUpdateId: string): void {
    this.db.prepare('UPDATE messages SET monday_update_id = ? WHERE id = ?').run(mondayUpdateId, id);
  }

  getMessage(id: number): ClaimMessage | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toMessage(r) : null;
  }

  getMessageByMondayUpdateId(mondayUpdateId: string): ClaimMessage | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE monday_update_id = ?').get(mondayUpdateId) as
      | Record<string, unknown>
      | undefined;
    return r ? toMessage(r) : null;
  }

  listMessages(itemId: string): ClaimMessage[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE item_id = ? ORDER BY id').all(itemId) as Array<
      Record<string, unknown>
    >;
    return rows.map(toMessage);
  }

  // --- files ---

  addFile(f: {
    itemId: string;
    source: FileSource;
    columnId: string | null;
    mondayAssetId: string | null;
    name: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
  }): ClaimFile | null {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO files (item_id, source, column_id, monday_asset_id, name, mime_type, size_bytes, storage_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.itemId, f.source, f.columnId, f.mondayAssetId, f.name, f.mimeType, f.sizeBytes, f.storageKey, nowIso());
    if (res.changes === 0) return null;
    return this.getFile(Number(res.lastInsertRowid));
  }

  setFileMondayAsset(id: number, columnId: string, mondayAssetId: string): void {
    this.db.prepare('UPDATE files SET column_id = ?, monday_asset_id = ? WHERE id = ?').run(columnId, mondayAssetId, id);
  }

  getFile(id: number): ClaimFile | null {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toFile(r) : null;
  }

  listFiles(itemId: string): ClaimFile[] {
    const rows = this.db.prepare('SELECT * FROM files WHERE item_id = ? ORDER BY id').all(itemId) as Array<
      Record<string, unknown>
    >;
    return rows.map(toFile);
  }

  deleteFile(id: number): void {
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }

  // --- templates (overrides only; defaults live in services/templates.ts) ---

  getTemplateOverride(key: TemplateKey): MessageTemplate | null {
    const r = this.db.prepare('SELECT * FROM templates WHERE key = ?').get(key) as Record<string, string> | undefined;
    return r
      ? {
          key: r.key as TemplateKey,
          emailSubject: r.email_subject!,
          emailBody: r.email_body!,
          sms: r.sms!,
          portalText: r.portal_text!,
        }
      : null;
  }

  saveTemplate(t: MessageTemplate, updatedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO templates (key, email_subject, email_body, sms, portal_text, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET email_subject = excluded.email_subject, email_body = excluded.email_body,
           sms = excluded.sms, portal_text = excluded.portal_text, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(t.key, t.emailSubject, t.emailBody, t.sms, t.portalText, nowIso(), updatedBy);
  }

  deleteTemplateOverride(key: TemplateKey): void {
    this.db.prepare('DELETE FROM templates WHERE key = ?').run(key);
  }

  // --- idempotency ---

  // Read-only check, for "do X once" steps that must record the key only after X succeeds.
  isEventProcessed(eventKey: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM processed_events WHERE event_key = ?').get(eventKey);
  }

  // True the first time a key is seen, false on every repeat.
  markEventProcessed(eventKey: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO processed_events (event_key, created_at) VALUES (?, ?)').run(eventKey, nowIso())
      .changes === 1;
  }
}

const toMessage = (r: Record<string, unknown>): ClaimMessage => ({
  id: r.id as number,
  itemId: r.item_id as string,
  direction: r.direction as MessageDirection,
  channel: r.channel as MessageChannel,
  body: r.body as string,
  mondayUpdateId: (r.monday_update_id as string | null) ?? null,
  highlevelMessageId: (r.highlevel_message_id as string | null) ?? null,
  createdAt: r.created_at as string,
});

const toFile = (r: Record<string, unknown>): ClaimFile => ({
  id: r.id as number,
  itemId: r.item_id as string,
  source: r.source as FileSource,
  columnId: (r.column_id as string | null) ?? null,
  mondayAssetId: (r.monday_asset_id as string | null) ?? null,
  name: r.name as string,
  mimeType: r.mime_type as string,
  sizeBytes: r.size_bytes as number,
  storageKey: r.storage_key as string,
  createdAt: r.created_at as string,
});
