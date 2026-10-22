import { describe, expect, it } from 'vitest';
import { visibleFileColumns } from '../src/board-config.js';
import type { Claim } from '../src/domain/types.js';
import { JOB } from '../src/services/contracts.js';
import {
  ClaimantInputError,
  MAX_CLAIMANT_BYTES_PER_CLAIM,
  MAX_CLAIMANT_FILES_PER_CLAIM,
  MAX_SYNC_BYTES,
  safeFileName,
} from '../src/services/files.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const ftyp = (major: string, ...compat: string[]) => {
  const size = 16 + compat.length * 4;
  return Buffer.concat([Buffer.from([0, 0, 0, size]), Buffer.from(`ftyp${major}`, 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from(compat.join(''), 'latin1'), Buffer.alloc(32)]);
};
const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(26), Buffer.from('[Content_Types].xml ... word/document.xml', 'latin1')]);
const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64), Buffer.from('This program cannot be run in DOS mode')]);

function makeClaim(env: TestEnv): Claim {
  const { tokens } = env.ctx.services;
  const item = addClaimItem(env);
  return env.ctx.repo.createClaim(
    {
      itemId: item.id,
      claimantName: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      statusKey: 'received',
      statusLabel: 'New',
      amountClaimed: 1250,
      receivedAt: '2026-10-22T14:00:00.000Z',
    },
    (id, v) => tokens.tokenHash(tokens.portalToken(id, v)),
  ).claim;
}

const upload = (name: string, data: Buffer, mimeType = 'application/octet-stream') => ({ name, mimeType, data });

async function rejection(p: Promise<unknown>): Promise<ClaimantInputError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ClaimantInputError);
    return err as ClaimantInputError;
  }
  throw new Error('expected a ClaimantInputError');
}

describe('safeFileName', () => {
  it('strips path parts and control/bidi characters, keeps the extension, caps the length', () => {
    expect(safeFileName('C:\\Users\\jane\\Desktop\\photo 1.JPG')).toBe('photo 1.JPG');
    expect(safeFileName('../../etc/pass\u202Ewd\u0000.html')).toBe('passwd.html');
    expect(safeFileName('a<b>:"c"|?*.png')).toBe('a_b___c____.png');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('')).toBe('file');
    const long = safeFileName(`${'x'.repeat(300)}.pdf`);
    expect(long).toHaveLength(100);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(safeFileName(`${'😀'.repeat(80)}.png`).length).toBeLessThanOrEqual(100);
  });
});

describe('syncFiles', () => {
  it('mirrors only the claimant-visible columns and never reads internal ones', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const c = env.board.columns;
    const shared = env.monday.attachFile(claim.itemId, 'file_shared_documents', upload('Estimate.pdf', PDF, 'application/pdf'));
    const photo = env.monday.attachFile(claim.itemId, c.intakePhotos!, upload('box.jpg', JPEG, 'image/jpeg'));
    const internal = env.monday.attachFile(claim.itemId, 'file_internal_notes', upload('fraud-check.pdf', PDF));

    await env.ctx.services.files.syncFiles(claim.itemId);

    const visible = visibleFileColumns(env.board).map((v) => v.columnId);
    expect(env.monday.callsTo('getItem')).toEqual([[claim.itemId, visible]]);
    expect(visible).not.toContain('file_internal_notes');
    const touched = [...env.monday.callsTo('getAssets').flat(2), ...env.monday.callsTo('downloadAsset').flat()];
    expect(touched).not.toContain(internal);

    const files = env.ctx.repo.listFiles(claim.itemId);
    expect(files.map((f) => [f.mondayAssetId, f.source, f.columnId, f.name, f.mimeType, f.sizeBytes])).toEqual([
      [shared, 'team', 'file_shared_documents', 'Estimate.pdf', 'application/pdf', PDF.length],
      [photo, 'claimant', c.intakePhotos, 'box.jpg', 'image/jpeg', JPEG.length],
    ]);
    expect(files[0]!.storageKey).toBe(`${claim.itemId}/${shared}-Estimate.pdf`);
    expect(await env.ctx.services.files.read(files[0]!)).toEqual(PDF);

    // A second sync downloads nothing new.
    await env.ctx.services.files.syncFiles(claim.itemId);
    expect(env.monday.callsTo('downloadAsset')).toHaveLength(2);
  });

  it('removes copies of files taken off the item but keeps uploads not yet attached', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { files } = env.ctx.services;
    const a = env.monday.attachFile(claim.itemId, 'file_shared_photos', upload('one.png', PNG, 'image/png'));
    const b = env.monday.attachFile(claim.itemId, 'file_shared_photos', upload('two.png', PNG, 'image/png'));
    await files.syncFiles(claim.itemId);
    const pending = await files.addClaimantUpload(claim, upload('receipt.pdf', PDF));
    const removed = env.ctx.repo.listFiles(claim.itemId).find((f) => f.mondayAssetId === a)!;

    env.monday.removeFile(claim.itemId, 'file_shared_photos', a);
    await files.syncFiles(claim.itemId);

    expect(env.ctx.repo.listFiles(claim.itemId).map((f) => f.mondayAssetId)).toEqual([b, null]);
    expect(env.store.files.has(removed.storageKey)).toBe(false);
    expect(env.store.files.has(pending.storageKey)).toBe(true);
  });

  it('serves unknown types as octet-stream and sanitises names from Monday', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const id = env.monday.attachFile(claim.itemId, 'file_shared_documents', upload('../x/pa\u202Ege.html', Buffer.from('<script>alert(1)</script>'), 'text/html'));

    await env.ctx.services.files.syncFiles(claim.itemId);

    const [f] = env.ctx.repo.listFiles(claim.itemId);
    expect(f).toMatchObject({ name: 'page.html', mimeType: 'application/octet-stream', storageKey: `${claim.itemId}/${id}-page.html` });
  });

  it('skips files over 100 MB without downloading them', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const id = env.monday.attachFile(claim.itemId, 'file_shared_documents', upload('huge.mp4', ftyp('isom', 'mp42')));
    env.monday.assets.get(id)!.fileSize = MAX_SYNC_BYTES + 1;

    await env.ctx.services.files.syncFiles(claim.itemId);

    expect(env.monday.callsTo('downloadAsset')).toHaveLength(0);
    expect(env.ctx.repo.listFiles(claim.itemId)).toEqual([]);
  });

  it('does nothing for items that are not claims', async () => {
    const env = makeTestEnv();
    const other = env.monday.addItem(env.board.claimsBoardId, 'Not a claim');
    await env.ctx.services.files.syncFiles(other.id);
    expect(env.monday.callsTo('getItem')).toHaveLength(0);
  });
});

describe('addClaimantUpload', () => {
  it('stores an allowed file at once with a type from its extension, and queues the Monday attach', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);

    const f = await env.ctx.services.files.addClaimantUpload(claim, upload('../../Damage photo.PNG', PNG, 'text/html'));

    expect(f).toMatchObject({ itemId: claim.itemId, source: 'claimant', columnId: null, mondayAssetId: null, name: 'Damage photo.PNG', mimeType: 'image/png', sizeBytes: PNG.length });
    expect(f.storageKey).toMatch(new RegExp(`^${claim.itemId}/u-[0-9a-f]{16}-Damage photo\\.PNG$`));
    expect(env.store.files.get(f.storageKey)).toEqual(PNG);
    const job = env.ctx.jobs.list().find((j) => j.type === JOB.uploadToMonday);
    expect(job).toMatchObject({ dedupe_key: `claimant-upload:${f.id}` });
    expect(JSON.parse(job!.payload)).toEqual({ fileId: f.id });
  });

  it('accepts every allowed format when the content matches', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const ok: Array<[string, Buffer]> = [
      ['a.jpg', JPEG],
      ['a.jpeg', JPEG],
      ['a.png', PNG],
      ['a.gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')],
      ['a.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])],
      ['a.heic', ftyp('heic', 'mif1', 'heic')],
      ['a.heif', ftyp('mif1', 'heic')],
      ['a.pdf', PDF],
      ['a.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])],
      ['a.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])],
      ['a.docx', DOCX],
      ['a.xlsx', Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('[Content_Types].xml xl/workbook.xml')])],
      ['a.txt', Buffer.from('Damage noticed at 3pm.\n')],
      ['a.csv', Buffer.from('item,cost\nchair,120\n')],
      ['a.mp4', ftyp('isom', 'iso2', 'mp41')],
      ['a.mov', ftyp('qt  ', 'qt  ')],
    ];
    for (const [name, data] of ok) {
      await expect(env.ctx.services.files.addClaimantUpload(claim, upload(name, data))).resolves.toMatchObject({ name });
    }
  });

  it('rejects empty, oversized, disallowed and spoofed files with a friendly message', async () => {
    const env = makeTestEnv({ config: { MAX_UPLOAD_BYTES: 1024 } });
    const claim = makeClaim(env);
    const { files } = env.ctx.services;

    expect((await rejection(files.addClaimantUpload(claim, upload('a.png', Buffer.alloc(0))))).code).toBe('empty_file');
    const big = await rejection(files.addClaimantUpload(claim, upload('a.png', Buffer.concat([PNG, Buffer.alloc(1024)]))));
    expect(big.code).toBe('file_too_large');
    expect(big.message).toMatch(/too large/);

    for (const name of ['setup.exe', 'page.html', 'image.svg', 'archive.zip', 'noextension']) {
      const err = await rejection(files.addClaimantUpload(claim, upload(name, PNG)));
      expect(err.code).toBe('unsupported_file_type');
      expect(err.message).toMatch(/photo|PDF/);
    }

    const spoofed: Array<[string, Buffer]> = [
      ['photo.jpg', PDF],
      ['photo.png', EXE],
      ['notes.txt', EXE],
      ['report.pdf', Buffer.from('<html><script>alert(1)</script></html>')],
      ['letter.docx', Buffer.from('PK\x03\x04 not an office file', 'latin1')],
      ['clip.mp4', ftyp('heic', 'mif1')],
      ['photo.heic', JPEG],
    ];
    for (const [name, data] of spoofed) {
      const err = await rejection(files.addClaimantUpload(claim, upload(name, data)));
      expect(err.code, name).toBe('file_content_mismatch');
    }

    expect(env.ctx.repo.listFiles(claim.itemId)).toEqual([]);
    expect(env.store.files.size).toBe(0);
    expect(env.ctx.jobs.list()).toHaveLength(0);
  });

  // A cached file row only (no bytes needed) to fill up a claim's allowance.
  const fileRow = (env: TestEnv, itemId: string, i: number, sizeBytes: number, source: 'team' | 'claimant' = 'claimant') =>
    env.ctx.repo.addFile({ itemId, source, columnId: null, mondayAssetId: null, name: `old-${i}.jpg`, mimeType: 'image/jpeg', sizeBytes, storageKey: `${itemId}/old-${i}` });

  it('caps the number of files a claimant can add to one claim', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const other = makeClaim(env);
    const { files } = env.ctx.services;
    for (let i = 0; i < MAX_CLAIMANT_FILES_PER_CLAIM - 1; i++) fileRow(env, claim.itemId, i, 1000);
    for (let i = 0; i < 5; i++) fileRow(env, claim.itemId, 1000 + i, 1000, 'team'); // the team's files don't count

    await files.addClaimantUpload(claim, upload('last.png', PNG));
    const err = await rejection(files.addClaimantUpload(claim, upload('one-more.png', PNG)));
    expect(err.message).toMatch(new RegExp(`already has ${MAX_CLAIMANT_FILES_PER_CLAIM} files`));
    expect(err.message).toMatch(/send us a message/);

    expect(env.ctx.repo.listFiles(claim.itemId).filter((f) => f.name === 'one-more.png')).toEqual([]);
    expect(env.store.files.size).toBe(1);
    expect(env.ctx.jobs.list().filter((j) => j.type === JOB.uploadToMonday)).toHaveLength(1);
    // Another claim has its own allowance.
    await expect(files.addClaimantUpload(other, upload('box.png', PNG))).resolves.toMatchObject({ itemId: other.itemId });
  });

  it('caps the total size of the files a claimant can add to one claim', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { files } = env.ctx.services;
    fileRow(env, claim.itemId, 0, MAX_CLAIMANT_BYTES_PER_CLAIM - 2 * PNG.length);

    await files.addClaimantUpload(claim, upload('fits.png', PNG));
    await files.addClaimantUpload(claim, upload('fits-too.png', PNG)); // exactly the allowance
    const err = await rejection(files.addClaimantUpload(claim, upload('over.png', PNG)));
    expect(err.message).toMatch(/over 500 MB in total/);
    expect(env.ctx.repo.listFiles(claim.itemId).map((f) => f.name)).toEqual(['old-0.jpg', 'fits.png', 'fits-too.png']);
    expect(env.store.files.size).toBe(2);
  });
});

describe('attachUploadToMonday', () => {
  it('attaches the upload to the claimant-uploads column once, posts an update and notifies the team', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { files } = env.ctx.services;
    const f = await files.addClaimantUpload(claim, upload('receipt.pdf', PDF));

    await env.ctx.jobs.drain();
    await files.attachUploadToMonday(f.id); // the job running again changes nothing

    const uploads = env.monday.callsTo('uploadFileToColumn');
    expect(uploads).toEqual([[claim.itemId, env.board.columns.claimantUploads, 'receipt.pdf']]);
    const stored = env.ctx.repo.getFile(f.id)!;
    expect(stored.columnId).toBe(env.board.columns.claimantUploads);
    expect(stored.mondayAssetId).toBeTruthy();
    expect(env.monday.assets.get(stored.mondayAssetId!)!.data).toEqual(PDF);

    const updates = env.monday.callsTo('createUpdate');
    expect(updates).toEqual([[claim.itemId, '<p>Claimant added receipt.pdf on the claim page.</p>']]);
    expect(env.monday.notifications).toEqual([
      { userId: '111', itemId: claim.itemId, text: `${claim.claimNumber}: new file from the claimant` },
      { userId: '222', itemId: claim.itemId, text: `${claim.claimNumber}: new file from the claimant` },
    ]);

    // The column-change sync that follows recognises the asset: no download, file kept.
    await files.syncFiles(claim.itemId);
    expect(env.monday.callsTo('downloadAsset')).toHaveLength(0);
    expect(env.ctx.repo.listFiles(claim.itemId).map((x) => x.id)).toEqual([f.id]);
  });

  it('retries after a failed upload without attaching twice', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { files } = env.ctx.services;
    const f = await files.addClaimantUpload(claim, upload('photo.jpg', JPEG));

    env.monday.failNext = 1;
    await expect(files.attachUploadToMonday(f.id)).rejects.toThrow();
    expect(env.ctx.repo.getFile(f.id)!.mondayAssetId).toBeNull();
    await files.attachUploadToMonday(f.id);
    await files.attachUploadToMonday(f.id);

    const attached = env.monday.mustItem(claim.itemId).columnValues[env.board.columns.claimantUploads]!.assetIds;
    expect(attached).toHaveLength(1);
    expect(env.monday.callsTo('createUpdate')).toHaveLength(1);
  });

  it('links an upload that landed despite a failed response, instead of attaching or mirroring a second copy', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { files } = env.ctx.services;
    const f = await files.addClaimantUpload(claim, upload('damage.jpg', JPEG));

    // /v2/file stores the file, then the response is lost (5xx or timeout).
    const realUpload = env.monday.uploadFileToColumn.bind(env.monday);
    let landed = '';
    let loseResponse = true;
    env.monday.uploadFileToColumn = async (itemId, columnId, file) => {
      const id = await realUpload(itemId, columnId, file);
      if (!loseResponse) return id;
      landed = id;
      throw new Error('Monday API returned 502 (it may still have been applied)');
    };
    await expect(files.attachUploadToMonday(f.id)).rejects.toThrow(/may still have been applied/);
    loseResponse = false;

    // The column-change webhook for the landed copy is handled before the job retries.
    await files.syncFiles(claim.itemId);
    expect(env.monday.callsTo('downloadAsset')).toHaveLength(0);
    expect(env.ctx.repo.listFiles(claim.itemId).map((x) => [x.id, x.mondayAssetId])).toEqual([[f.id, null]]);

    await files.attachUploadToMonday(f.id);

    expect(env.monday.callsTo('uploadFileToColumn')).toHaveLength(1);
    expect(env.monday.mustItem(claim.itemId).columnValues[env.board.columns.claimantUploads]!.assetIds).toEqual([landed]);
    expect(env.ctx.repo.getFile(f.id)).toMatchObject({ mondayAssetId: landed, columnId: env.board.columns.claimantUploads });
    expect(env.monday.callsTo('createUpdate')).toHaveLength(1);
    await files.syncFiles(claim.itemId);
    expect(env.ctx.repo.listFiles(claim.itemId).map((x) => x.id)).toEqual([f.id]);
  });

  it("uploads again after a failure that didn't land, even when another copy of the same file is on the item", async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { files } = env.ctx.services;
    // The claimant added the same photo twice.
    const a = await files.addClaimantUpload(claim, upload('same.jpg', JPEG));
    const b = await files.addClaimantUpload(claim, upload('same.jpg', JPEG));
    await files.attachUploadToMonday(a.id);

    env.monday.failNext = 1;
    await expect(files.attachUploadToMonday(b.id)).rejects.toThrow();
    await files.syncFiles(claim.itemId);
    await files.attachUploadToMonday(b.id);

    const assets = env.monday.mustItem(claim.itemId).columnValues[env.board.columns.claimantUploads]!.assetIds!;
    expect(assets).toHaveLength(2);
    expect(assets).toEqual([env.ctx.repo.getFile(a.id)!.mondayAssetId, env.ctx.repo.getFile(b.id)!.mondayAssetId]);
  });

  it('still mirrors a team file in the claimant-uploads column that only shares a pending upload\'s name', async () => {
    const env = makeTestEnv();
    const claim = makeClaim(env);
    const { files } = env.ctx.services;
    const f = await files.addClaimantUpload(claim, upload('photo.jpg', JPEG));
    env.monday.failNext = 1;
    await expect(files.attachUploadToMonday(f.id)).rejects.toThrow(); // attempted, didn't land
    const other = env.monday.attachFile(claim.itemId, env.board.columns.claimantUploads, upload('photo.jpg', Buffer.concat([JPEG, JPEG]), 'image/jpeg'));

    await files.syncFiles(claim.itemId);

    expect(env.ctx.repo.listFiles(claim.itemId).map((x) => x.mondayAssetId)).toEqual([null, other]);
  });
});
