import { generateKeyPairSync, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MondayItem } from '../src/adapters/monday/types.js';
import { businessDate } from '../src/services/claim-fields.js';
import { buildApp } from '../src/web/app.js';
import { DEVICE_COOKIE } from '../src/web/routes/portal.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

// One claim, start to finish, driven only from the outside: Monday and HighLevel
// webhooks posted to the HTTP endpoints, the claimant's browser on the portal,
// and the job queue drained in between, as the worker would. Steps run in order
// and share state.

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b00000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const INTERNAL_FILE_COLUMN = 'file_internal_adjuster'; // not listed in board.json: internal
const BANK_ACCOUNT = '000123456789';
const BANK_ROUTING = '021000021';

// Marketplace InboundMessage webhooks are Ed25519-signed; the test plays HighLevel.
const hlKeys = generateKeyPairSync('ed25519');
const HL_PUBLIC_KEY = hlKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

let env: TestEnv;
let app: FastifyInstance;
let item: MondayItem;
let token = '';
let portalUrl = '';
let cookie = '';
let contactId = '';
let paymentSignature = '';
let trigger = 0;

interface Delivery {
  url: string;
  payload: string;
  headers: Record<string, string>;
}
const deliveries: Delivery[] = [];

beforeAll(async () => {
  env = makeTestEnv({ config: { HIGHLEVEL_WEBHOOK_PUBLIC_KEY: HL_PUBLIC_KEY } });
  app = await buildApp(env.ctx);
});
afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
});

// --- the outside world ---

const drain = () => env.ctx.jobs.drain();

async function deliver(path: 'monday' | 'highlevel', body: unknown, headers: Record<string, string> = {}) {
  const d: Delivery = {
    url: `/webhooks/${path}/${env.config.WEBHOOK_SECRET}`,
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  };
  deliveries.push(d);
  const res = await app.inject({ method: 'POST', url: d.url, payload: d.payload, headers: d.headers });
  expect(res.statusCode).toBe(200);
  return res.json() as { ok: boolean; result?: string; ignored?: string };
}

// Monday's envelope: ids as numbers, `type` differs from the subscription name.
function mondayEvent(type: string, boardId: string, itemId: string, fields: Record<string, unknown> = {}) {
  return {
    event: {
      app: 'monday',
      type,
      triggerTime: new Date().toISOString(),
      subscriptionId: 410_001,
      isRetry: false,
      userId: 111,
      originalTriggerUuid: null,
      boardId: Number(boardId),
      pulseId: Number(itemId),
      triggerUuid: `trig-${++trigger}`,
      ...fields,
    },
  };
}

const statusValue = (text: string) => ({
  label: { index: 1, text, style: { color: '#fdab3d', border: '#e99729', var_name: 'orange' }, is_done: false },
  post_id: null,
});

// The team (or the integration) sets a status; Monday fires change_status_column_value.
async function setStatus(label: string, userId = 111) {
  const col = env.board.columns.status;
  const previous = env.monday.mustItem(item.id).columnValues[col]?.text ?? null;
  env.monday.setText(item.id, col, label, 'status');
  return deliver(
    'monday',
    mondayEvent('update_column_value', env.board.claimsBoardId, item.id, {
      userId,
      groupId: 'topics',
      pulseName: item.name,
      columnId: col,
      columnType: 'color',
      columnTitle: 'Status',
      value: statusValue(label),
      previousValue: previous ? statusValue(previous) : null,
      changedAt: Date.now() / 1000,
      isTopGroup: true,
    }),
  );
}

// The team writes an update on the item; Monday fires create_update.
async function postUpdate(text: string, creatorId = '111', updateId?: string) {
  const id = updateId ?? env.monday.addTeamUpdate(item.id, text, creatorId).id;
  return deliver(
    'monday',
    mondayEvent('create_update', env.board.claimsBoardId, item.id, {
      userId: Number(creatorId),
      body: `<p>${text}</p>`,
      textBody: text,
      updateId: Number(id),
      replyId: null,
    }),
  );
}

// A file column changed (change_specific_column_value).
function fileColumnChanged(columnId: string) {
  const col = env.monday.mustItem(item.id).columnValues[columnId];
  const files = (col?.assetIds ?? []).map((assetId) => ({
    name: env.monday.assets.get(assetId)!.name,
    assetId: Number(assetId),
    isImage: 'false',
    fileType: 'ASSET',
    createdAt: Date.now(),
    createdBy: '111',
  }));
  return deliver(
    'monday',
    mondayEvent('update_column_value', env.board.claimsBoardId, item.id, { columnId, columnType: 'file', columnTitle: 'Files', value: { files } }),
  );
}

// HighLevel workflow "Webhook" action: the standard contact payload plus custom data.
function workflowWebhook(customData: Record<string, string>, extra: Record<string, unknown> = {}) {
  return deliver('highlevel', {
    contact_id: contactId,
    first_name: 'Jane',
    last_name: 'Doe',
    full_name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+16035550100',
    tags: 'hdc-claimant',
    location: { id: env.config.HIGHLEVEL_LOCATION_ID, name: 'Home Delivery Claims' },
    workflow: { id: 'wf_1', name: 'HDC' },
    triggerData: {},
    customData: { contact_id: contactId, claim_number: 'HDC-000001', ...customData },
    ...extra,
  });
}

// Marketplace InboundMessage, signed over the exact bytes sent.
function signedInboundMessage(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const signature = sign(null, Buffer.from(raw), hlKeys.privateKey).toString('base64');
  return deliver('highlevel', body, { 'x-ghl-signature': signature });
}

// --- the claimant's browser ---

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

function multipart(parts: Array<{ name: string; value?: string; filename?: string; type?: string; data?: Buffer }>) {
  const boundary = `----hdce2e${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const head =
      p.filename !== undefined
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}\r\n\r\n`
        : `Content-Disposition: form-data; name="${p.name}"\r\n\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${head}`), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const browserGet = (url: string) => app.inject({ method: 'GET', url, cookies: cookie ? { [DEVICE_COOKIE]: cookie } : {} });
const browserPost = (url: string, body: { payload: string | Buffer; headers: Record<string, string> }) =>
  app.inject({ method: 'POST', url, cookies: cookie ? { [DEVICE_COOKIE]: cookie } : {}, ...body });

const csrfFrom = (page: string): string => {
  const m = page.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('no CSRF field on the page');
  return m[1]!;
};

async function claimPage(): Promise<string> {
  const res = await browserGet(portalUrl);
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<h1>HDC-000001</h1>');
  return res.body;
}

// --- bookkeeping ---

const lastEmail = () => env.highlevel.emails.at(-1)!;
const lastSms = () => env.highlevel.sms.at(-1)!;
const updatesOnClaim = () =>
  env.monday
    .callsTo('createUpdate')
    .filter(([id]) => id === item.id)
    .map(([, body]) => String(body));
const column = (it: MondayItem, id: string) => env.monday.mustItem(it.id).columnValues[id]?.text ?? null;

// Everything that reaches the claimant, the team or the board as a new thing.
const sends = () => ({
  emails: env.highlevel.emails.length,
  sms: env.highlevel.sms.length,
  updates: env.monday.callsTo('createUpdate').length,
  notifications: env.monday.notifications.length,
  uploads: env.monday.callsTo('uploadFileToColumn').length,
  settlements: env.highlevel.settlementRequests.length,
  messages: env.ctx.repo.listMessages(item.id).length,
  files: env.ctx.repo.listFiles(item.id).length,
});

describe('end to end: one claim from the form to the payment', () => {
  it('(a) a new form item gets a claim number, a contact and a confirmation with a working link', async () => {
    item = addClaimItem(env, { name: 'Jane Doe', email: 'jane@example.com', phone: '+16035550100', smsOptIn: true, amount: 1250 });
    // The form's photo, and a file the team keeps in an internal column.
    env.monday.attachFile(item.id, env.board.columns.intakePhotos!, { name: 'damage.jpg', mimeType: 'image/jpeg', data: JPEG });
    env.monday.attachFile(item.id, INTERNAL_FILE_COLUMN, { name: 'adjuster-notes.pdf', mimeType: 'application/pdf', data: PDF });

    const created = mondayEvent('create_pulse', env.board.claimsBoardId, item.id, {
      userId: -4, // form submissions have no real user
      pulseName: 'Jane Doe',
      groupId: 'topics',
      groupName: 'New claims',
      isTopGroup: true,
      columnValues: { [env.board.columns.email]: { email: 'jane@example.com', text: 'jane@example.com' } },
    });
    expect(await deliver('monday', created)).toMatchObject({ ok: true, result: 'queued' });
    expect(await deliver('monday', created)).toMatchObject({ result: 'duplicate' });
    await drain();

    const claim = env.ctx.repo.getClaim(item.id)!;
    expect(claim).toMatchObject({ claimNumber: 'HDC-000001', email: 'jane@example.com', phone: '+16035550100', smsOptIn: true, statusKey: 'received' });

    // Written back to the item.
    const c = env.board.columns;
    expect(column(item, c.claimNumber)).toBe('HDC-000001');
    // The New York date, as the confirmation email and the claim page give it.
    expect(column(item, c.dateReceived!)).toBe(businessDate(claim.receivedAt));
    portalUrl = new URL(column(item, c.portalLink!)!).pathname;
    expect(portalUrl).toMatch(/^\/c\/[A-Za-z0-9_-]{43}$/);
    token = portalUrl.slice(3);

    // HighLevel contact.
    expect(env.highlevel.contacts.size).toBe(1);
    const contact = [...env.highlevel.contacts.values()][0]!;
    contactId = contact.id;
    expect(contact).toMatchObject({ email: 'jane@example.com', phone: '+16035550100', smsOptIn: true });
    expect(contact.customFields.claim_number).toBe('HDC-000001');
    expect(claim.highlevelContactId).toBe(contactId);

    // Confirmation by email and, since they opted in, SMS; both carry the number and the link.
    expect(env.highlevel.emails).toHaveLength(1);
    const email = lastEmail();
    expect(email.contactId).toBe(contactId);
    expect(email.subject).toContain('HDC-000001');
    expect(email.text).toContain('HDC-000001');
    expect(email.text).toContain(`${env.config.PUBLIC_BASE_URL}${portalUrl}`);
    expect(email.html).toContain(`href="${env.config.PUBLIC_BASE_URL}${portalUrl}"`);
    expect(env.highlevel.sms).toHaveLength(1);
    expect(lastSms().message).toContain('HDC-000001');
    expect(lastSms().message).toContain(`${env.config.PUBLIC_BASE_URL}${portalUrl}`);
    expect(lastSms().message).not.toContain('1,250');

    // The link in the email resolves to this claim.
    expect(env.ctx.services.tokens.claimForToken(token)?.itemId).toBe(item.id);

    // The form photo can land after create_item, so it is mirrored a little later.
    expect(env.ctx.repo.listFiles(item.id)).toHaveLength(0);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    await drain();
    vi.useRealTimers();
    expect(env.ctx.repo.listFiles(item.id).map((f) => [f.name, f.source])).toEqual([['damage.jpg', 'claimant']]);
  });

  it('(b) the link asks for a code, the emailed code verifies the browser, and the claim page shows the status', async () => {
    const first = await browserGet(portalUrl);
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Open your claim');
    expect(first.body).toContain('j***@e***.com');
    expect(first.body).not.toContain('HDC-000001'); // nothing about the claim before verification
    cookie = (first.cookies as Array<{ name: string; value: string }>).find((c) => c.name === DEVICE_COOKIE)!.value;
    const csrf = csrfFrom(first.body);

    const emailsBefore = env.highlevel.emails.length;
    const smsBefore = env.highlevel.sms.length;
    const sent = await browserPost(`${portalUrl}/code`, form({ _csrf: csrf }));
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(`${portalUrl}?code=sent`);
    expect(env.highlevel.emails).toHaveLength(emailsBefore + 1);
    expect(env.highlevel.sms).toHaveLength(smsBefore); // codes go by email only
    const codeEmail = lastEmail();
    expect(codeEmail.subject).toBe('Your sign-in code for claim HDC-000001');
    const code = codeEmail.text.match(/^(\d{6})$/m)![1]!;

    const codeForm = await browserGet(`${portalUrl}?code=sent`);
    expect(codeForm.body).toContain('Enter your code');

    const wrong = await browserPost(`${portalUrl}/verify`, form({ _csrf: csrf, code: code === '000000' ? '111111' : '000000' }));
    expect(wrong.statusCode).toBe(400);
    const ok = await browserPost(`${portalUrl}/verify`, form({ _csrf: csrf, code }));
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe(`${portalUrl}?verified=1`);

    const page = await browserGet(`${portalUrl}?verified=1`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<h1>HDC-000001</h1>');
    expect(page.body).toContain('this device is verified');
    expect(page.body).toMatch(/<span class="badge">New<\/span>/);
    expect(page.body).toContain('Claim received');
    expect(page.body).toContain('damage.jpg');

    // Another browser with the same link still has to verify.
    const stranger = await app.inject({ method: 'GET', url: portalUrl });
    expect(stranger.body).not.toContain('HDC-000001');
  });

  it('(c) a "To claimant:" update is emailed and shown on the portal; an internal update is not', async () => {
    const before = sends();
    expect(await postUpdate('To claimant: please send a photo of the box')).toMatchObject({ result: 'queued' });
    await drain();

    expect(env.highlevel.emails).toHaveLength(before.emails + 1);
    const email = lastEmail();
    expect(email.subject).toBe('New message about your claim HDC-000001');
    expect(email.text).toContain('please send a photo of the box');
    expect(email.text).not.toContain('To claimant:');
    expect(email.text).toContain(`${env.config.PUBLIC_BASE_URL}${portalUrl}`);
    expect(env.highlevel.sms).toHaveLength(before.sms + 1);
    expect(lastSms().message).toContain('new message about claim HDC-000001');

    let page = await claimPage();
    expect(page).toMatch(/<strong>Claims team<\/strong>[\s\S]*please send a photo of the box/);

    // Internal notes, and the integration's own posts, never reach the claimant.
    const afterMessage = sends();
    await postUpdate('Carrier says the box was dropped at the depot');
    await postUpdate('To claimant: this one is posted by the integration user', env.config.MONDAY_INTEGRATION_USER_ID);
    await drain();
    expect(sends()).toEqual(afterMessage);
    page = await claimPage();
    expect(page).not.toContain('dropped at the depot');
    expect(page).not.toContain('posted by the integration user');
  });

  it('(d) a portal reply and upload reach Monday and the team', async () => {
    const page = await claimPage();
    const csrf = csrfFrom(page);
    const before = sends();

    // No CSRF token, no message.
    const forged = await browserPost(`${portalUrl}/messages`, form({ message: 'forged' }));
    expect(forged.statusCode).toBe(403);

    const posted = await browserPost(`${portalUrl}/messages`, form({ _csrf: csrf, message: 'Here is the box <b>photo</b> you asked for.' }));
    expect(posted.statusCode).toBe(303);
    expect(posted.headers.location).toBe(`${portalUrl}?sent=1#messages`);

    const uploaded = await browserPost(
      `${portalUrl}/files`,
      multipart([
        { name: '_csrf', value: csrf },
        { name: 'files', filename: 'box.png', type: 'image/png', data: PNG },
      ]),
    );
    expect(uploaded.statusCode).toBe(303);
    expect(uploaded.headers.location).toBe(`${portalUrl}?uploaded=1#files`);
    // Stored at once, before Monday has heard about it.
    expect((await claimPage())).toContain('Here is the box &lt;b&gt;photo&lt;/b&gt; you asked for.');

    await drain();

    const updates = updatesOnClaim();
    const reply = updates.find((u) => u.includes('From claimant (claim page):'))!;
    expect(reply).toContain('Here is the box &lt;b&gt;photo&lt;/b&gt; you asked for.');
    expect(env.monday.callsTo('uploadFileToColumn')).toEqual([[item.id, env.board.columns.claimantUploads, 'box.png']]);
    const uploadsCol = env.monday.mustItem(item.id).columnValues[env.board.columns.claimantUploads]!;
    expect(uploadsCol.assetIds).toHaveLength(1);
    expect(env.monday.assets.get(uploadsCol.assetIds![0]!)!.data.equals(PNG)).toBe(true);
    expect(updates.some((u) => u.includes('Claimant added box.png on the claim page.'))).toBe(true);
    const notified = env.monday.notifications.slice(before.notifications).map((n) => `${n.userId}: ${n.text}`);
    expect(notified.sort()).toEqual(
      [
        '111: HDC-000001: new file from the claimant',
        '111: HDC-000001: new message from the claimant',
        '222: HDC-000001: new file from the claimant',
        '222: HDC-000001: new message from the claimant',
      ].sort(),
    );
    // Nothing went back to the claimant.
    expect(env.highlevel.emails).toHaveLength(before.emails);

    // Monday then reports our own update and the file column change: neither echoes nor duplicates.
    const ours = env.ctx.repo.listMessages(item.id).find((m) => m.direction === 'from_claimant')!;
    const settled = sends();
    await postUpdate('From claimant (claim page): Here is the box photo you asked for.', env.config.MONDAY_INTEGRATION_USER_ID, ours.mondayUpdateId!);
    expect(await fileColumnChanged(env.board.columns.claimantUploads)).toMatchObject({ result: 'queued' });
    await drain();
    expect(sends()).toEqual(settled);
    expect(env.ctx.repo.listFiles(item.id).filter((f) => f.name === 'box.png')).toHaveLength(1);
  });

  it('(e) a file on a shared column appears on the claim page; one in an internal column never does', async () => {
    const assetId = env.monday.attachFile(item.id, 'file_shared_documents', { name: 'estimate.pdf', mimeType: 'application/pdf', data: PDF });
    expect(await fileColumnChanged('file_shared_documents')).toMatchObject({ result: 'queued' });
    const internal = await fileColumnChanged(INTERNAL_FILE_COLUMN);
    expect(internal.ignored).toBeDefined();
    await drain();

    const page = await claimPage();
    const estimate = env.ctx.repo.listFiles(item.id).find((f) => f.mondayAssetId === assetId)!;
    expect(estimate).toMatchObject({ name: 'estimate.pdf', source: 'team', mimeType: 'application/pdf' });
    expect(page).toMatch(/estimate\.pdf<\/a> <span class="muted small">[^<]*From the claims team/);
    const download = await browserGet(`${portalUrl}/files/${estimate.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="estimate\.pdf"/);
    expect(download.rawPayload.equals(PDF)).toBe(true);

    // The internal column was never requested, so its file never left Monday.
    expect(page).not.toContain('adjuster-notes');
    for (const [, columnIds] of env.monday.callsTo('getItem')) {
      expect(columnIds).toBeInstanceOf(Array);
      expect(columnIds).not.toContain(INTERNAL_FILE_COLUMN);
    }
    const internalAsset = env.monday.mustItem(item.id).columnValues[INTERNAL_FILE_COLUMN]!.assetIds![0]!;
    expect(env.monday.callsTo('downloadAsset').flat()).not.toContain(internalAsset);
  });

  it('(f) settlement offered -> document sent; verified signature -> board label -> payment form email', async () => {
    env.monday.setText(item.id, env.board.columns.settlementAmount, '850', 'numbers');
    const before = sends();
    expect(await setStatus('Settlement offered')).toMatchObject({ result: 'queued' });
    await drain();

    expect(env.highlevel.settlementRequests).toHaveLength(1);
    expect(env.highlevel.settlementRequests[0]).toMatchObject({ contactId, claimNumber: 'HDC-000001', itemId: item.id, settlementAmount: 850 });
    expect(env.ctx.repo.getClaim(item.id)).toMatchObject({ statusKey: 'settlement_offered', settlementAmountSent: 850 });
    expect(updatesOnClaim().some((u) => u.includes('Settlement document sent to the claimant for signature ($850.00)'))).toBe(true);
    expect(env.highlevel.emails).toHaveLength(before.emails + 1);
    expect(lastEmail().subject).toBe('Your settlement offer for claim HDC-000001 is ready');
    // The amount is on the claim page and the document, never in email or SMS.
    for (const m of [lastEmail().text, lastEmail().html, lastSms().message]) expect(m).not.toMatch(/850/);
    expect(await claimPage()).toMatch(/Your settlement offer<\/h2>\s*<p class="amount">\$850\.00<\/p>/);

    // A "signed" webhook before the claimant has actually signed is checked and ignored.
    await workflowWebhook({ hdc_event: 'document_signed' });
    await drain();
    expect(column(item, env.board.columns.status)).toBe('Settlement offered');
    expect(env.ctx.repo.getClaim(item.id)!.settlementSignedAt).toBeNull();

    // The claimant signs; HighLevel's workflow calls us; the API confirms it.
    env.highlevel.sign();
    const emailsBeforeSigned = env.highlevel.emails.length;
    await workflowWebhook({ hdc_event: 'document_signed' });
    await drain();
    expect(column(item, env.board.columns.status)).toBe('Settlement signed');
    expect(env.ctx.repo.getClaim(item.id)!.settlementSignedAt).not.toBeNull();
    expect(updatesOnClaim().some((u) => u.includes('Settlement signed by the claimant') && u.includes('203.0.113.7'))).toBe(true);
    expect(env.highlevel.emails).toHaveLength(emailsBeforeSigned); // the status webhook sends it

    // Monday reports the integration's own label change like any other.
    expect(await setStatus('Settlement signed', Number(env.config.MONDAY_INTEGRATION_USER_ID))).toMatchObject({ result: 'queued' });
    await drain();
    const email = lastEmail();
    expect(email.subject).toBe("Claim HDC-000001: choose how you'd like to be paid");
    const link = email.text.match(/https:\/\/forms\.monday\.com\/\S+/)![0];
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe('https://forms.monday.com/forms/paymentform');
    expect(url.searchParams.get('r')).toBe('use1');
    expect(url.searchParams.get(env.board.paymentForm.claimNumberParam)).toBe('HDC-000001');
    paymentSignature = url.searchParams.get(env.board.paymentForm.signatureParam)!;
    expect(paymentSignature).toBe(env.ctx.services.payment.paymentSignature('HDC-000001'));
    expect(lastSms().message).not.toContain('forms.monday.com');

    const page = await claimPage();
    expect(page).toContain('<h2 id="payment-title">Choose how you\'d like to be paid</h2>');
    expect(page).toContain(`href="${link.replace(/&/g, '&amp;')}"`);
  });

  it('(g) payment details: a genuine submission is verified, a tampered one is flagged', async () => {
    const pb = env.board.paymentBoard!;
    const submit = (claimNumber: string, ref: string) => {
      const p = env.monday.addItem(pb.boardId, 'Jane Doe', {
        [pb.claimNumberColumn]: { text: claimNumber },
        [pb.signatureColumn]: { text: ref },
        text_routing: { text: BANK_ROUTING },
        text_account: { text: BANK_ACCOUNT },
        [pb.verificationColumn]: { type: 'status', text: null },
      });
      return { p, delivered: deliver('monday', mondayEvent('create_pulse', pb.boardId, p.id, { pulseName: 'Jane Doe', userId: -4 })) };
    };

    const genuine = submit('HDC-000001', paymentSignature);
    expect(await genuine.delivered).toMatchObject({ result: 'queued' });
    await drain();
    expect(column(genuine.p, pb.verificationColumn)).toBe(pb.verifiedLabel);
    expect(env.monday.callsTo('getItem').filter(([id]) => id === genuine.p.id)).toEqual([[genuine.p.id, [pb.claimNumberColumn, pb.signatureColumn]]]);
    expect(env.ctx.repo.getClaim(item.id)!.paymentDetailsReceivedAt).not.toBeNull();
    expect(updatesOnClaim().some((u) => u.includes('Payment details were submitted (verified)'))).toBe(true);
    const page = await claimPage();
    expect(page).toContain('Payment details received');
    expect(page).not.toContain('forms.monday.com');

    // Someone edits their own link to point at this claim: the signature can't match.
    const tampered = submit('HDC-000001', env.ctx.services.payment.paymentSignature('HDC-000002'));
    await tampered.delivered;
    await drain();
    expect(column(tampered.p, pb.verificationColumn)).toBe(pb.mismatchLabel);
    expect(updatesOnClaim().some((u) => u.includes("didn't verify") && u.includes(tampered.p.id))).toBe(true);

    // Bank details never pass through the integration.
    const everything = JSON.stringify([env.monday.calls, env.highlevel.calls, env.ctx.repo.listMessages(item.id)]);
    expect(everything).not.toContain(BANK_ACCOUNT);
    expect(everything).not.toContain(BANK_ROUTING);
  });

  it('(h) payment sent -> final email; STATUS by SMS gets a reply; an email reply reaches Monday', async () => {
    const before = sends();
    await setStatus('Payment sent');
    await drain();
    expect(env.highlevel.emails).toHaveLength(before.emails + 1);
    expect(lastEmail().subject).toBe('Your payment for claim HDC-000001 is on its way');
    expect(lastSms().message).toContain('Your payment for claim HDC-000001 has been sent');
    expect(await claimPage()).toContain('<span class="badge badge-done">Payment sent</span>');

    // "Customer Replied" workflow, SMS channel: the STATUS keyword.
    const updatesBefore = env.monday.callsTo('createUpdate').length;
    await workflowWebhook(
      { hdc_event: 'inbound_message', message_body: 'Status', message_type: 'SMS', message_id: 'hl_sms_status_1' },
      { message: { type: 2, body: 'Status' } },
    );
    await drain();
    expect(lastSms()).toEqual({
      contactId,
      message: `Home Delivery Claims: Claim HDC-000001: Payment sent. Details: ${env.config.PUBLIC_BASE_URL}${portalUrl}`,
    });
    expect(env.monday.callsTo('createUpdate')).toHaveLength(updatesBefore); // not a message for the team

    // Marketplace InboundMessage (signed), an email reply quoting our last email.
    await signedInboundMessage({
      type: 'InboundMessage',
      locationId: env.config.HIGHLEVEL_LOCATION_ID,
      attachments: [],
      body: '<div dir="ltr">Got it, thank you!<br>The payment arrived today.</div><div class="gmail_quote"><div>On Thu, Oct 22, 2026 at 9:14 AM Home Delivery Claims wrote:</div><blockquote>Your payment for claim HDC-000001 has been sent</blockquote></div>',
      contactId,
      contentType: 'text/html',
      conversationId: 'conv_1',
      dateAdded: new Date().toISOString(),
      direction: 'inbound',
      messageType: 'Email',
      messageId: 'hl_email_reply_1',
      subject: 'Re: Your payment for claim HDC-000001 is on its way',
      from: 'Jane Doe <jane@example.com>',
      to: [env.config.HIGHLEVEL_EMAIL_FROM],
    });
    // A forged one (bad signature) is refused.
    const forged = await app.inject({
      method: 'POST',
      url: `/webhooks/highlevel/${env.config.WEBHOOK_SECRET}`,
      payload: JSON.stringify({ type: 'InboundMessage', contactId, messageType: 'SMS', direction: 'inbound', body: 'STOP' }),
      headers: { 'content-type': 'application/json', 'x-ghl-signature': Buffer.alloc(64).toString('base64') },
    });
    expect(forged.statusCode).toBe(401);
    await drain();

    const reply = updatesOnClaim().at(-1)!;
    expect(reply).toContain('From claimant (email):');
    expect(reply).toContain('Got it, thank you!');
    expect(reply).toContain('The payment arrived today.');
    expect(reply).not.toContain('has been sent');
    expect(env.monday.notifications.slice(-2).map((n) => n.text)).toEqual([
      'HDC-000001: new message from the claimant',
      'HDC-000001: new message from the claimant',
    ]);
    expect(await claimPage()).toMatch(/<strong>You<\/strong>[\s\S]*Got it, thank you!/);
    expect(env.ctx.repo.getClaim(item.id)!.smsOptedOut).toBe(false);
  });

  it('(i) every webhook delivered again (same triggerUuid / message id) sends nothing twice', async () => {
    const before = sends();
    const columnWrites = env.monday.callsTo('changeColumnValues').length;
    for (const d of deliveries) {
      const res = await app.inject({ method: 'POST', url: d.url, payload: d.payload, headers: d.headers });
      expect(res.statusCode).toBe(200);
    }
    await drain();
    expect(sends()).toEqual(before);
    expect(env.monday.callsTo('changeColumnValues')).toHaveLength(columnWrites);
  });

  it('(i) every job can run again (a retry after a crash) without sending anything twice', async () => {
    const before = sends();
    const jobs = env.ctx.db.prepare("SELECT type, payload FROM jobs WHERE status = 'done' ORDER BY id").all() as Array<{ type: string; payload: string }>;
    expect(new Set(jobs.map((j) => j.type)).size).toBeGreaterThanOrEqual(9);
    for (const j of jobs) env.ctx.jobs.enqueue(j.type, JSON.parse(j.payload));
    await drain();
    expect(env.ctx.jobs.list('dead')).toEqual([]);
    expect(sends()).toEqual(before);
    expect(column(item, env.board.columns.status)).toBe('Payment sent');
  });
});
