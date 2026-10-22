import { randomBytes } from 'node:crypto';
import type { MondayAsset } from '../adapters/monday/types.js';
import { visibleFileColumns } from '../board-config.js';
import type { Claim, ClaimFile, FileSource } from '../domain/types.js';
import { escapeHtml } from '../web/html.js';
import { onceFor } from './claim-fields.js';
import { JOB, type CoreContext, type FileService, type Services } from './contracts.js';
import { ClaimantInputError } from './errors.js';
import { PermanentJobError } from './jobs.js';
import { notifyTeam } from './messaging.js';

export { ClaimantInputError } from './errors.js';

// Mirrors the claimant-visible file columns into our own store (Monday's
// public_url is never exposed or logged) and takes claimant uploads from the
// portal. Internal file columns are never requested from Monday.

// Team files larger than this are not mirrored.
export const MAX_SYNC_BYTES = 100 * 1024 * 1024;
// Per-claim allowance for files from the claimant, so one claim can't fill the
// disk (shared with the database) or flood Monday and the team's notifications.
export const MAX_CLAIMANT_FILES_PER_CLAIM = 100;
export const MAX_CLAIMANT_BYTES_PER_CLAIM = 500 * 1024 * 1024;
const ASSET_BATCH = 50;
const MAX_NAME_CHARS = 100;

// The only content types we ever record, so a cached file can't be served as
// HTML/SVG/script whatever Monday or the browser claimed it was.
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};
const SAFE_MIMES = new Set(Object.values(MIME_BY_EXT));
const GENERIC_MIME = 'application/octet-stream';

// --- content sniffing ---

const at = (b: Buffer, offset: number, sig: string | number[]): boolean => {
  const bytes = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  return b.length >= offset + bytes.length && b.subarray(offset, offset + bytes.length).equals(bytes);
};

// Brands of a leading ISO base media `ftyp` box (MP4, MOV, HEIF), or null.
function ftypBrands(b: Buffer): string[] | null {
  if (!at(b, 4, 'ftyp')) return null;
  const size = Math.min(b.readUInt32BE(0), b.length, 256);
  if (size < 16) return null;
  const brands = [b.toString('latin1', 8, 12)];
  for (let o = 16; o + 4 <= size; o += 4) brands.push(b.toString('latin1', o, o + 4));
  return brands;
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'heif', 'mif1', 'mif2', 'msf1']);
// QuickTime files from older cameras start with a bare atom instead of ftyp.
const QT_ATOMS = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'];

const isJpeg = (b: Buffer) => at(b, 0, [0xff, 0xd8, 0xff]);
const isPng = (b: Buffer) => at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isGif = (b: Buffer) => at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a');
const isWebp = (b: Buffer) => at(b, 0, 'RIFF') && at(b, 8, 'WEBP');
const isHeif = (b: Buffer) => !!ftypBrands(b)?.some((x) => HEIF_BRANDS.has(x));
const isVideo = (b: Buffer) => {
  const brands = ftypBrands(b);
  if (brands) return !brands.some((x) => HEIF_BRANDS.has(x));
  return QT_ATOMS.some((a) => at(b, 4, a));
};
const isPdf = (b: Buffer) => b.subarray(0, 1024).includes('%PDF-');
const isOle = (b: Buffer) => at(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const isRtf = (b: Buffer) => at(b, 0, '{\\rtf');
const isOoxml = (dir: string) => (b: Buffer) => at(b, 0, 'PK\x03\x04') && b.includes('[Content_Types].xml') && b.includes(dir);
// Plain text has no NUL bytes; executables and other binaries do, early on.
const isText = (b: Buffer) => !b.subarray(0, 64 * 1024).includes(0);

// Extension -> does the content match it. Doubles as the upload allowlist.
const UPLOAD_CHECKS: Record<string, (b: Buffer) => boolean> = {
  jpg: isJpeg,
  jpeg: isJpeg,
  png: isPng,
  gif: isGif,
  webp: isWebp,
  heic: isHeif,
  heif: isHeif,
  pdf: isPdf,
  doc: (b) => isOle(b) || isRtf(b),
  xls: isOle,
  docx: isOoxml('word/'),
  xlsx: isOoxml('xl/'),
  txt: isText,
  csv: isText,
  mp4: isVideo,
  mov: isVideo,
};
export const ALLOWED_UPLOAD_EXTENSIONS: readonly string[] = Object.keys(UPLOAD_CHECKS);

// --- names ---

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

// A display/storage name from an untrusted file name: no directory parts, no
// control or bidi-override characters, no characters Windows rejects, the
// extension kept, at most 100 characters.
export function safeFileName(raw: string, fallback = 'file'): string {
  const base = (String(raw ?? '').normalize('NFC').split(/[/\\]/).pop() ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const dot = base.lastIndexOf('.');
  let ext = dot > 0 ? base.slice(dot + 1) : '';
  let stem = dot > 0 ? base.slice(0, dot) : base;
  if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) {
    ext = '';
    stem = base;
  }
  const max = MAX_NAME_CHARS - (ext ? ext.length + 1 : 0);
  // Cut by code point so a surrogate pair is never split.
  const chars = Array.from(stem).slice(0, max);
  while (chars.join('').length > max) chars.pop();
  stem = chars.join('').replace(/[.\s]+$/, '') || fallback;
  return ext ? `${stem}.${ext}` : stem;
}

const mimeFor = (name: string, reported?: string): string => {
  const byExt = MIME_BY_EXT[extOf(name)];
  if (byExt) return byExt;
  const r = reported?.split(';')[0]?.trim().toLowerCase();
  return r && SAFE_MIMES.has(r) ? r : GENERIC_MIME;
};

const formatMb = (bytes: number): string => String(Number((bytes / (1024 * 1024)).toFixed(1)));

const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Recorded just before a claimant upload is sent to Monday. /v2/file can fail
// (5xx, timeout) after the file has landed, so once this is set the asset may
// already be in the claimant-uploads column.
const uploadAttemptKey = (fileId: number): string => `claimant-upload:${fileId}:attempted`;

// Whether a Monday asset is the copy of this claimant upload: same name and size.
const isCopyOf = (meta: MondayAsset | undefined, f: ClaimFile): boolean =>
  !!meta && meta.fileSize === f.sizeBytes && safeFileName(meta.name ?? '') === f.name;

export function createFileService(ctx: CoreContext, _services: Services): FileService {
  const { board, config, db, repo, jobs, monday, store, log } = ctx;

  async function assetMeta(ids: string[]): Promise<Map<string, MondayAsset>> {
    const out = new Map<string, MondayAsset>();
    for (let i = 0; i < ids.length; i += ASSET_BATCH) {
      for (const a of await monday.getAssets(ids.slice(i, i + ASSET_BATCH))) out.set(String(a.id), a);
    }
    return out;
  }

  async function mirror(itemId: string, assetId: string, col: { columnId: string; source: FileSource }, meta: MondayAsset | undefined): Promise<void> {
    if (!meta || !ASSET_ID_RE.test(assetId)) {
      log.warn({ itemId, assetId }, 'files: asset not available, skipped');
      return;
    }
    if ((meta.fileSize ?? 0) > MAX_SYNC_BYTES) {
      log.warn({ itemId, assetId, sizeBytes: meta.fileSize }, 'files: file too large to mirror, skipped');
      return;
    }
    const dl = await monday.downloadAsset(assetId);
    if (dl.data.length > MAX_SYNC_BYTES) {
      log.warn({ itemId, assetId, sizeBytes: dl.data.length }, 'files: file too large to mirror, skipped');
      return;
    }
    const name = safeFileName(meta.name || dl.name);
    const storageKey = `${itemId}/${assetId}-${name}`;
    await store.put(storageKey, dl.data);
    const f = repo.addFile({
      itemId,
      source: col.source,
      columnId: col.columnId,
      mondayAssetId: assetId,
      name,
      mimeType: mimeFor(name, dl.mimeType),
      sizeBytes: dl.data.length,
      storageKey,
    });
    if (f) log.info({ itemId, assetId, fileId: f.id }, 'files: mirrored file from Monday');
    else log.warn({ itemId, assetId }, 'files: asset already recorded elsewhere, not added');
  }

  async function syncFiles(itemId: string): Promise<void> {
    if (!repo.getClaim(itemId)) {
      log.info({ itemId }, 'files: no claim for item, skipping sync');
      return;
    }
    const columns = visibleFileColumns(board);
    // Only the visible columns are requested: internal files never leave Monday.
    const item = await monday.getItem(
      itemId,
      columns.map((c) => c.columnId),
    );
    if (!item) {
      log.warn({ itemId }, 'files: item not found, skipping sync');
      return;
    }

    // Where each asset is now. A column missing from the response has no files.
    const current = new Map<string, { columnId: string; source: FileSource }>();
    for (const col of columns) {
      for (const assetId of item.columnValues[col.columnId]?.assetIds ?? []) {
        if (!current.has(String(assetId))) current.set(String(assetId), col);
      }
    }

    // Drop copies of files removed from the item (or from every visible column).
    // Claimant uploads still waiting to be attached have no asset id yet and stay.
    const known = new Set<string>();
    for (const f of repo.listFiles(itemId)) {
      if (!f.mondayAssetId) continue;
      const now = current.get(f.mondayAssetId);
      if (!now) {
        await store.delete(f.storageKey);
        repo.deleteFile(f.id);
        log.info({ itemId, fileId: f.id, assetId: f.mondayAssetId }, 'files: removed file no longer on the item');
        continue;
      }
      known.add(f.mondayAssetId);
      if (f.columnId !== now.columnId) repo.setFileMondayAsset(f.id, now.columnId, f.mondayAssetId);
    }

    const missing = [...current.keys()].filter((a) => !known.has(a));
    if (!missing.length) return;
    const meta = await assetMeta(missing);
    // Claimant uploads sent to Monday but not yet linked to their asset (the
    // attach failed ambiguously, or is still finishing). Their copy in the
    // claimant-uploads column is linked by attachUploadToMonday, not mirrored again.
    const unlinked = repo
      .listFiles(itemId)
      .filter((f) => f.source === 'claimant' && !f.mondayAssetId && repo.isEventProcessed(uploadAttemptKey(f.id)));
    // One failed download shouldn't hold up the rest; the job retries the remainder.
    let failure: unknown = null;
    for (const assetId of missing) {
      const col = current.get(assetId)!;
      if (col.columnId === board.columns.claimantUploads) {
        const i = unlinked.findIndex((f) => isCopyOf(meta.get(assetId), f));
        if (i >= 0) {
          log.info({ itemId, assetId, fileId: unlinked[i]!.id }, 'files: asset is a claimant upload still being attached, not mirrored');
          unlinked.splice(i, 1);
          continue;
        }
      }
      try {
        await mirror(itemId, assetId, col, meta.get(assetId));
      } catch (err) {
        failure ??= err;
        log.warn({ itemId, assetId }, 'files: download failed, will retry');
      }
    }
    if (failure) throw failure;
  }

  // Throws when one more file of this size would take the claim over its allowance.
  function checkAllowance(itemId: string, size: number): void {
    const { count, bytes } = repo.claimantFileTotals(itemId);
    if (count >= MAX_CLAIMANT_FILES_PER_CLAIM || bytes + size > MAX_CLAIMANT_BYTES_PER_CLAIM) {
      log.warn({ itemId, count, sizeBytes: bytes }, 'files: claimant upload refused, claim is at its upload allowance');
    }
    if (count >= MAX_CLAIMANT_FILES_PER_CLAIM) {
      throw new ClaimantInputError(
        `Your claim already has ${MAX_CLAIMANT_FILES_PER_CLAIM} files from you, which is the most we can take on the claim page. If you need to send us more, please send us a message and we'll help.`,
      );
    }
    if (bytes + size > MAX_CLAIMANT_BYTES_PER_CLAIM) {
      throw new ClaimantInputError(
        `This file would take the files you've added to your claim over ${formatMb(MAX_CLAIMANT_BYTES_PER_CLAIM)} MB in total, which is the most we can take on the claim page. If you need to send us more, please send us a message and we'll help.`,
      );
    }
  }

  // The asset an earlier, failed attempt left in the column, if it landed after
  // all: same name and size, and not already the copy of another cached file.
  async function landedUpload(f: ClaimFile, columnId: string): Promise<string | null> {
    const item = await monday.getItem(f.itemId, [columnId]);
    const linked = new Set(repo.listFiles(f.itemId).map((x) => x.mondayAssetId));
    const candidates = (item?.columnValues[columnId]?.assetIds ?? []).map(String).filter((a) => ASSET_ID_RE.test(a) && !linked.has(a));
    if (!candidates.length) return null;
    const meta = await assetMeta(candidates);
    return candidates.find((a) => isCopyOf(meta.get(a), f)) ?? null;
  }

  async function addClaimantUpload(claim: Claim, file: { name: string; mimeType: string; data: Buffer }): Promise<ClaimFile> {
    const data = file.data;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new ClaimantInputError('That file is empty. Please choose another file.', 'empty_file');
    }
    if (data.length > config.MAX_UPLOAD_BYTES) {
      throw new ClaimantInputError(`That file is too large. Each file can be up to ${formatMb(config.MAX_UPLOAD_BYTES)} MB.`, 'file_too_large');
    }
    const name = safeFileName(file.name);
    const ext = extOf(name);
    const check = Object.hasOwn(UPLOAD_CHECKS, ext) ? UPLOAD_CHECKS[ext] : undefined;
    if (!check) {
      throw new ClaimantInputError(
        "We can't accept that type of file. Please upload a photo (JPG, PNG, GIF, WebP or HEIC), a PDF, a Word or Excel document, a text or CSV file, or an MP4 or MOV video.",
        'unsupported_file_type',
      );
    }
    if (!check(data)) {
      throw new ClaimantInputError(
        `That file doesn't look like a .${ext} file, so we can't accept it. Please check the file and try again.`,
        'file_content_mismatch',
      );
    }

    checkAllowance(claim.itemId, data.length);

    const storageKey = `${claim.itemId}/u-${randomBytes(8).toString('hex')}-${name}`;
    await store.put(storageKey, data);
    try {
      const f = db.transaction(() => {
        // Again, atomically with the insert: another upload may have finished meanwhile.
        checkAllowance(claim.itemId, data.length);
        const added = repo.addFile({
          itemId: claim.itemId,
          source: 'claimant',
          columnId: null,
          mondayAssetId: null,
          name,
          mimeType: MIME_BY_EXT[ext]!,
          sizeBytes: data.length,
          storageKey,
        });
        if (!added) throw new Error('Claimant upload was not recorded');
        jobs.enqueue(JOB.uploadToMonday, { fileId: added.id }, { dedupeKey: `claimant-upload:${added.id}` });
        return added;
      })();
      log.info({ itemId: claim.itemId, fileId: f.id, sizeBytes: f.sizeBytes }, 'files: claimant uploaded a file');
      return f;
    } catch (err) {
      await store.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  async function attachUploadToMonday(fileId: number): Promise<void> {
    const f = repo.getFile(fileId);
    if (!f || f.source !== 'claimant') {
      log.warn({ fileId }, 'files: no claimant upload to attach');
      return;
    }
    const claim = repo.getClaim(f.itemId);
    if (!claim) throw new PermanentJobError(`No claim for file ${fileId}`);

    if (!f.mondayAssetId) {
      const columnId = board.columns.claimantUploads;
      const attemptKey = uploadAttemptKey(f.id);
      // A retry: the last attempt may have landed even though it failed. Link
      // that asset rather than put a second copy on the item.
      const landed = repo.isEventProcessed(attemptKey) ? await landedUpload(f, columnId) : null;
      if (landed) {
        repo.setFileMondayAsset(f.id, columnId, landed);
        log.info({ itemId: f.itemId, fileId, assetId: landed }, 'files: earlier attempt had attached the claimant upload; linked it');
      } else {
        let data: Buffer;
        try {
          data = await store.get(f.storageKey);
        } catch {
          throw new PermanentJobError(`Upload ${fileId} is missing from the file store`);
        }
        repo.markEventProcessed(attemptKey);
        const assetId = await monday.uploadFileToColumn(f.itemId, columnId, { name: f.name, mimeType: f.mimeType, data });
        // Recorded as soon as we know it; until then syncFiles leaves a matching asset alone.
        repo.setFileMondayAsset(f.id, columnId, String(assetId));
        log.info({ itemId: f.itemId, fileId, assetId }, 'files: claimant upload attached to Monday');
      }
    }

    const key = `claimant-upload:${f.id}`;
    await onceFor(ctx, `${key}:update`, (once) =>
      monday.createUpdate(f.itemId, `<p>Claimant added ${escapeHtml(f.name)} on the claim page.</p>`, once),
    );
    await notifyTeam(ctx, claim, key, `${claim.claimNumber}: new file from the claimant`);
  }

  return {
    syncFiles,
    addClaimantUpload,
    attachUploadToMonday,
    read: (file) => store.get(file.storageKey),
  };
}
