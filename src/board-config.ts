import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { STATUS_KEYS, type StatusKey } from './domain/types.js';

// Mapping between our domain and the client's Monday boards. Column ids and
// status labels are agreed in the walkthrough and written to config/board.json.
const BoardConfigSchema = z.object({
  claimsBoardId: z.string().min(1),
  claimsBoardUrl: z.url().optional(),
  columns: z.object({
    claimNumber: z.string(),
    status: z.string(),
    email: z.string(),
    phone: z.string(),
    smsOptIn: z.string(),
    amountClaimed: z.string().optional(),
    settlementAmount: z.string(),
    // Date received, written by the integration when the claim number is assigned.
    dateReceived: z.string().optional(),
    // Photos uploaded on the claim form. Shown to the claimant as their own uploads.
    intakePhotos: z.string().optional(),
    // Where files the claimant adds on the portal are attached.
    claimantUploads: z.string(),
    // Where the signed settlement PDF is attached.
    signedSettlement: z.string(),
    // Text column holding the private claim link, so the team can resend it.
    portalLink: z.string().optional(),
  }),
  // File columns whose contents appear on the claim page. Any file column not
  // listed here (or in intakePhotos/claimantUploads/signedSettlement) is internal.
  sharedFileColumns: z.array(z.string()).default([]),
  // Status label on the board -> claimant-facing status key. Labels not listed
  // are internal and trigger no message.
  statuses: z.record(z.string(), z.enum(STATUS_KEYS)),
  // Label the integration sets when the settlement is signed.
  settlementSignedLabel: z.string().default('Settlement signed'),
  // Monday WorkForm for new claims, embedded on /start-a-claim.
  claimForm: z.object({
    embedUrl: z.url(),
  }),
  // Monday WorkForm on the private finance board, pre-filled with the claim number.
  paymentForm: z.object({
    url: z.url(),
    // WorkForm pre-fill "lookup" names (set per question in the form editor; only
    // short-text questions pre-fill reliably).
    claimNumberParam: z.string(),
    // Hidden question carrying an HMAC of the claim number, so an edited link
    // can't attach bank details to someone else's claim unnoticed.
    signatureParam: z.string(),
  }),
  // Optional: the payment details board. The integration only ever reads the
  // claim-number and signature columns from it, never the bank details, and
  // writes a verification label so finance can see the submission is genuine.
  paymentBoard: z
    .object({
      boardId: z.string(),
      claimNumberColumn: z.string(),
      signatureColumn: z.string(),
      // Status column the integration sets to verifiedLabel / mismatchLabel.
      verificationColumn: z.string(),
      verifiedLabel: z.string().default('Verified'),
      mismatchLabel: z.string().default('Check claim number'),
    })
    .optional(),
  // An update on the item that starts with this prefix is sent to the claimant.
  claimantMessagePrefix: z.string().default('To claimant:'),
  // Monday user ids notified when a claimant writes in or uploads a file.
  notifyUserIds: z.array(z.string()).default([]),
});

export type BoardConfig = z.infer<typeof BoardConfigSchema>;

export function parseBoardConfig(raw: unknown): BoardConfig {
  return BoardConfigSchema.parse(raw);
}

export function loadBoardConfig(path: string): BoardConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Board config ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = BoardConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid board config ${path}:\n${issues}`);
  }
  return parsed.data;
}

// Status label -> key, case- and whitespace-insensitive.
export function statusKeyForLabel(cfg: BoardConfig, label: string | null | undefined): StatusKey | null {
  if (!label) return null;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(label);
  for (const [l, key] of Object.entries(cfg.statuses)) {
    if (norm(l) === target) return key;
  }
  return null;
}

// Every file column the claimant can see, with who it is attributed to.
export function visibleFileColumns(cfg: BoardConfig): Array<{ columnId: string; source: 'team' | 'claimant' }> {
  const cols: Array<{ columnId: string; source: 'team' | 'claimant' }> = [];
  for (const c of cfg.sharedFileColumns) cols.push({ columnId: c, source: 'team' });
  cols.push({ columnId: cfg.columns.signedSettlement, source: 'team' });
  if (cfg.columns.intakePhotos) cols.push({ columnId: cfg.columns.intakePhotos, source: 'claimant' });
  cols.push({ columnId: cfg.columns.claimantUploads, source: 'claimant' });
  const seen = new Set<string>();
  return cols.filter((c) => (seen.has(c.columnId) ? false : (seen.add(c.columnId), true)));
}
