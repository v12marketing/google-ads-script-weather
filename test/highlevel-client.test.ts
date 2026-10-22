import { describe, expect, it } from 'vitest';
import { HighLevelApiError, HighLevelClient, formatFrom, formatUsd, toE164 } from '../src/adapters/highlevel/client.js';
import { testConfig } from '../src/config.js';

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: any;
}
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Handler = (call: Call) => Reply | Promise<Reply>;

// Routes "METHOD /path" to handlers; an array of handlers is consumed one per call.
function mockFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    const handler = Array.isArray(route) ? route.shift() : route;
    if (!handler) return new Response(JSON.stringify({ message: `no mock for ${call.method} ${call.path}` }), { status: 404 });
    const r = await handler(call);
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers });
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

const LOC = 'loc_test';
const FIELDS_PATH = `GET /locations/${LOC}/customFields`;
const fields = (): Reply => ({
  json: {
    customFields: [
      { id: 'cf_claim', name: 'Claim Number', fieldKey: 'contact.claim_number', dataType: 'TEXT', model: 'contact' },
      { id: 'cf_amount', name: 'Settlement Amount', fieldKey: 'contact.settlement_amount', dataType: 'TEXT', model: 'contact' },
      // Matched by name: the fieldKey HighLevel generated differs from ours.
      { id: 'cf_portal', name: 'Portal URL', fieldKey: 'contact.claim_portal_link', dataType: 'TEXT', model: 'contact' },
      { id: 'cf_other', name: 'Other', fieldKey: 'contact.other', dataType: 'TEXT', model: 'contact' },
    ],
  },
});

const config = testConfig({ HIGHLEVEL_API_TOKEN: 'pit-secret-token' });
const client = (routes: Record<string, Handler | Handler[]>, timeoutMs?: number) => {
  const m = mockFetch(routes);
  return { hl: new HighLevelClient(config, { fetch: m.fetch, timeoutMs }), calls: m.calls };
};

describe('HighLevelClient transport', () => {
  it('sends the PIT, Accept json and the per-endpoint Version header', async () => {
    const { hl, calls } = client({
      'POST /contacts/c1/tags': () => ({ json: { tags: ['a'] } }),
      'POST /conversations/messages': () => ({ json: { messageId: 'm1', conversationId: 'cv1', status: 'pending' } }),
    });
    await hl.addTags('c1', ['a']);
    await hl.sendSms({ contactId: 'c1', message: 'hi' });
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer pit-secret-token');
    expect(calls[0]!.headers.get('accept')).toBe('application/json');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.headers.get('version')).toBe('2021-07-28');
    expect(calls[1]!.headers.get('version')).toBe('2021-04-15');
  });

  it('reports the status code and HighLevel message, without the token', async () => {
    const { hl } = client({ 'POST /contacts/c1/tags': () => ({ status: 422, json: { statusCode: 422, message: ['tags must be an array'] } }) });
    const err = (await hl.addTags('c1', ['x']).catch((e) => e)) as HighLevelApiError;
    expect(err).toBeInstanceOf(HighLevelApiError);
    expect(err.status).toBe(422);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('HTTP 422');
    expect(err.message).toContain('tags must be an array');
    expect(err.message).not.toContain('pit-secret-token');
  });

  it('marks 429 as rate limited and retryable', async () => {
    const { hl } = client({
      'POST /contacts/c1/tags': () => ({ status: 429, json: { message: 'Too many requests' }, headers: { 'X-RateLimit-Interval-Milliseconds': '10000' } }),
    });
    const err = (await hl.addTags('c1', ['x']).catch((e) => e)) as HighLevelApiError;
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/HTTP 429.*rate limited.*retry/);
  });

  it('5xx is retryable; 401 hints at the token', async () => {
    const { hl } = client({
      'POST /contacts/c1/tags': [() => ({ status: 502, json: { message: 'Bad gateway' } }), () => ({ status: 401, json: { message: 'Invalid JWT' } })],
    });
    const e1 = (await hl.addTags('c1', ['x']).catch((e) => e)) as HighLevelApiError;
    expect(e1.retryable).toBe(true);
    const e2 = (await hl.addTags('c1', ['x']).catch((e) => e)) as HighLevelApiError;
    expect(e2.message).toMatch(/HTTP 401.*HIGHLEVEL_API_TOKEN/);
  });

  it('times out slow requests', async () => {
    const hl = new HighLevelClient(config, {
      timeoutMs: 20,
      fetch: ((_u: unknown, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch,
    });
    const err = (await hl.addTags('c1', ['x']).catch((e) => e)) as HighLevelApiError;
    expect(err).toBeInstanceOf(HighLevelApiError);
    expect(err.status).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('timed out');
  });

  it('redacts portal link tokens from error text', async () => {
    const { hl } = client({
      [FIELDS_PATH]: fields,
      'PUT /contacts/c1': () => ({ status: 400, json: { message: 'bad value https://claims.test/c/SECRETTOKEN123' } }),
    });
    const err = (await hl.updateContactFields('c1', { portal_url: 'https://claims.test/c/SECRETTOKEN123' }).catch((e) => e)) as Error;
    expect(err.message).not.toContain('SECRETTOKEN123');
    expect(err.message).toContain('/c/[redacted]');
  });

  it('encodes ids in paths', async () => {
    const { hl, calls } = client({ 'POST /contacts/a%2Fb/tags': () => ({ json: {} }) });
    await hl.addTags('a/b', ['x']);
    expect(calls[0]!.path).toBe('/contacts/a%2Fb/tags');
  });
});

describe('HighLevelClient contacts', () => {
  it('upserts with mapped custom fields, then adds tags separately; field ids load once', async () => {
    const { hl, calls } = client({
      [FIELDS_PATH]: fields,
      'POST /contacts/upsert': () => ({ json: { new: true, contact: { id: 'contact_9' }, traceId: 't' } }),
      'POST /contacts/contact_9/tags': () => ({ json: {} }),
    });
    const id = await hl.upsertContact({
      name: 'Jane Q Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '(603) 555-0100',
      smsOptIn: true,
      tags: ['hdc-claimant'],
      customFields: { claim_number: 'HDC-000123', portal_url: 'https://claims.test/c/tok' },
    });
    expect(id).toBe('contact_9');
    await hl.upsertContact({ name: 'Jane Q Doe', firstName: 'Jane', email: 'jane@example.com', phone: null, smsOptIn: false, customFields: { claim_number: 'HDC-000124' } });

    expect(calls.filter((c) => c.path === `/locations/${LOC}/customFields`)).toHaveLength(1);
    expect(calls[0]!.query.get('model')).toBe('contact');
    const upsert = calls.find((c) => c.path === '/contacts/upsert')!;
    expect(upsert.body).toEqual({
      locationId: LOC,
      name: 'Jane Q Doe',
      firstName: 'Jane',
      lastName: 'Q Doe',
      email: 'jane@example.com',
      phone: '+16035550100',
      source: 'HomeDeliveryClaims.com',
      customFields: [
        { id: 'cf_claim', field_value: 'HDC-000123' },
        { id: 'cf_portal', field_value: 'https://claims.test/c/tok' },
      ],
    });
    expect(upsert.body).not.toHaveProperty('tags');
    expect(upsert.body).not.toHaveProperty('dnd');
    expect(upsert.body).not.toHaveProperty('dndSettings');
    const tags = calls.find((c) => c.path === '/contacts/contact_9/tags')!;
    expect(tags.method).toBe('POST');
    expect(tags.body).toEqual({ tags: ['hdc-claimant'] });
    // Second upsert: no tags call, no phone.
    expect(calls.filter((c) => c.path === '/contacts/contact_9/tags')).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/contacts/upsert')[1]!.body).not.toHaveProperty('phone');
  });

  it('upserts without custom fields without loading them', async () => {
    const { hl, calls } = client({ 'POST /contacts/upsert': () => ({ json: { contact: { id: 'c2' } } }) });
    expect(await hl.upsertContact({ name: 'Bo', firstName: 'Bo', email: null, phone: '+447700900123', smsOptIn: false })).toBe('c2');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ locationId: LOC, name: 'Bo', firstName: 'Bo', phone: '+447700900123', source: 'HomeDeliveryClaims.com' });
  });

  it('refuses a contact with no email or phone, and fails clearly without a contact id', async () => {
    const { hl } = client({ 'POST /contacts/upsert': () => ({ json: {} }) });
    await expect(hl.upsertContact({ name: 'X', firstName: 'X', email: null, phone: 'abc', smsOptIn: false })).rejects.toThrow(/no usable email or phone/);
    await expect(hl.upsertContact({ name: 'X', firstName: 'X', email: 'x@example.com', phone: null, smsOptIn: false })).rejects.toThrow(/no contact id/);
  });

  it('names a missing custom field and reloads the list on the next call', async () => {
    const without = (): Reply => ({ json: { customFields: [{ id: 'cf_claim', name: 'Claim Number', fieldKey: 'contact.claim_number' }] } });
    const { hl, calls } = client({
      [FIELDS_PATH]: [without, without, fields],
      'PUT /contacts/c1': () => ({ json: { succeded: true } }),
    });
    await expect(hl.updateContactFields('c1', { claim_number: 'HDC-1', settlement_amount: '$1.00' })).rejects.toThrow(
      /settlement_amount.*Settlement Amount.*scripts\/highlevel-setup\.ts fields/,
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    // Staff created the field: the next attempt picks it up.
    await hl.updateContactFields('c1', { claim_number: 'HDC-1', settlement_amount: '$1.00' });
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      customFields: [
        { id: 'cf_claim', field_value: 'HDC-1' },
        { id: 'cf_amount', field_value: '$1.00' },
      ],
    });
  });

  it('updateContactFields sends custom fields only (never tags)', async () => {
    const { hl, calls } = client({ [FIELDS_PATH]: fields, 'PUT /contacts/c1': () => ({ json: {} }) });
    await hl.updateContactFields('c1', { claim_number: 'HDC-000123' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers.get('version')).toBe('2021-07-28');
    expect(Object.keys(put.body)).toEqual(['customFields']);
    await hl.updateContactFields('c1', {});
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('adds and removes tags via the tags endpoint', async () => {
    const { hl, calls } = client({ 'POST /contacts/c1/tags': () => ({ json: {} }), 'DELETE /contacts/c1/tags': () => ({ json: {} }) });
    await hl.addTags('c1', ['a', 'b']);
    await hl.removeTags('c1', ['a']);
    await hl.addTags('c1', []);
    await hl.removeTags('c1', []);
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/contacts/c1/tags', { tags: ['a', 'b'] }],
      ['DELETE', '/contacts/c1/tags', { tags: ['a'] }],
    ]);
  });
});

describe('HighLevelClient messages', () => {
  it('sends email with html, subject and a formatted emailFrom', async () => {
    const { hl, calls } = client({ 'POST /conversations/messages': () => ({ json: { conversationId: 'cv', messageId: 'msg_1', emailMessageId: 'em', status: 'pending' } }) });
    const res = await hl.sendEmail({ contactId: 'c1', subject: 'Your claim', html: '<p>Hi</p>', text: 'Hi' });
    expect(res).toEqual({ messageId: 'msg_1' });
    expect(calls[0]!.body).toEqual({
      type: 'Email',
      contactId: 'c1',
      subject: 'Your claim',
      html: '<p>Hi</p>',
      emailFrom: 'Home Delivery Claims <claims@claims.test>',
    });
  });

  it('sends SMS with message', async () => {
    const { hl, calls } = client({ 'POST /conversations/messages': () => ({ json: { conversationId: 'cv', messageId: 'msg_2', status: 'pending' } }) });
    expect(await hl.sendSms({ contactId: 'c1', message: 'Update on HDC-1' })).toEqual({ messageId: 'msg_2' });
    expect(calls[0]!.body).toEqual({ type: 'SMS', contactId: 'c1', message: 'Update on HDC-1' });
  });

  it('returns null messageId when HighLevel omits it', async () => {
    const { hl } = client({ 'POST /conversations/messages': () => ({ json: { status: 'pending' } }) });
    expect(await hl.sendSms({ contactId: 'c1', message: 'x' })).toEqual({ messageId: null });
  });

  it('resends once with status when HighLevel requires it, and keeps sending it', async () => {
    const { hl, calls } = client({
      'POST /conversations/messages': [
        () => ({ status: 400, json: { statusCode: 400, message: ['status must be one of the following values: delivered, failed, pending, read'] } }),
        () => ({ json: { messageId: 'm1' } }),
        () => ({ json: { messageId: 'm2' } }),
      ],
    });
    expect(await hl.sendSms({ contactId: 'c1', message: 'a' })).toEqual({ messageId: 'm1' });
    expect(await hl.sendSms({ contactId: 'c1', message: 'b' })).toEqual({ messageId: 'm2' });
    expect(calls.map((c) => c.body.status)).toEqual([undefined, 'pending', 'pending']);
  });

  it('does not resend on unrelated 400s and explains a subType requirement', async () => {
    const { hl, calls } = client({
      'POST /conversations/messages': [
        () => ({ status: 400, json: { message: 'Contact has DND active for SMS' } }),
        () => ({ status: 400, json: { message: ['subType must be an object'] } }),
      ],
    });
    await expect(hl.sendSms({ contactId: 'c1', message: 'a' })).rejects.toThrow(/HTTP 400.*DND/);
    await expect(hl.sendSms({ contactId: 'c1', message: 'a' })).rejects.toThrow(/requires subType.*HighLevel support/);
    expect(calls).toHaveLength(2);
  });
});

describe('HighLevelClient settlement', () => {
  // Contact store so the post-PUT read-back reflects what was written.
  function settlementRoutes(opts: { dropAmount?: boolean; links?: unknown[] } = {}) {
    const saved = new Map<string, string>();
    return {
      [FIELDS_PATH]: fields,
      'PUT /contacts/contact_1': (c: Call) => {
        for (const f of c.body.customFields) if (!(opts.dropAmount && f.id === 'cf_amount')) saved.set(f.id, f.field_value);
        return { json: { succeded: true } };
      },
      'GET /contacts/contact_1': () => ({ json: { contact: { id: 'contact_1', customFields: [...saved].map(([id, value]) => ({ id, value })) } } }),
      'POST /proposals/templates/send': () => ({
        json: {
          success: true,
          links: opts.links ?? [
            { referenceId: 'ref-user', documentId: 'doc-uuid', recipientId: 'user_hl', entityName: 'users', recipientCategory: 'cc' },
            { referenceId: 'ref-claimant', documentId: 'doc-uuid', recipientId: 'contact_1', entityName: 'contacts', recipientCategory: 'recipient' },
          ],
        },
      }),
    } satisfies Record<string, Handler>;
  }
  const req = { contactId: 'contact_1', claimNumber: 'HDC-000123', itemId: '42', settlementAmount: 12500, claimantName: 'Jane Doe', portalUrl: 'https://claims.test/c/tok' };

  it('writes the fields, confirms them, sends the template and returns both ids', async () => {
    const { hl, calls } = client(settlementRoutes());
    expect(await hl.requestSettlementSignature(req)).toEqual({ documentId: 'doc-uuid', referenceId: 'ref-claimant' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      FIELDS_PATH,
      'PUT /contacts/contact_1',
      'GET /contacts/contact_1',
      'POST /proposals/templates/send',
    ]);
    expect(calls[1]!.body.customFields).toEqual([
      { id: 'cf_claim', field_value: 'HDC-000123' },
      { id: 'cf_amount', field_value: '$12,500.00' },
      { id: 'cf_portal', field_value: 'https://claims.test/c/tok' },
    ]);
    const send = calls[3]!;
    expect(send.headers.get('version')).toBe('2021-07-28');
    expect(send.body).toEqual({ templateId: 'tmpl_settlement', userId: 'user_hl', locationId: LOC, contactId: 'contact_1', sendDocument: true });
  });

  it('does not send the document when a field did not save', async () => {
    const { hl, calls } = client(settlementRoutes({ dropAmount: true }));
    const err = (await hl.requestSettlementSignature(req).catch((e) => e)) as Error;
    expect(err.message).toMatch(/settlement_amount did not save; settlement not sent/);
    expect(err.message).not.toContain('/c/tok');
    expect(calls.some((c) => c.path === '/proposals/templates/send')).toBe(false);
  });

  it('rejects an invalid amount before calling HighLevel', async () => {
    const { hl, calls } = client(settlementRoutes());
    await expect(hl.requestSettlementSignature({ ...req, settlementAmount: 0 })).rejects.toThrow(/invalid settlement amount/);
    await expect(hl.requestSettlementSignature({ ...req, settlementAmount: Number.NaN })).rejects.toThrow(/invalid settlement amount/);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the first link, and to nulls when there are none', async () => {
    const a = client(settlementRoutes({ links: [{ referenceId: 'r1', documentId: 'd1', recipientId: 'someone', recipientCategory: 'recipient' }] }));
    expect(await a.hl.requestSettlementSignature(req)).toEqual({ documentId: 'd1', referenceId: 'r1' });
    const b = client(settlementRoutes({ links: [] }));
    expect(await b.hl.requestSettlementSignature(req)).toEqual({ documentId: null, referenceId: null });
  });

  it('throws when HighLevel reports success=false', async () => {
    const routes = { ...settlementRoutes(), 'POST /proposals/templates/send': () => ({ json: { success: false, links: [] } }) };
    const { hl } = client(routes);
    await expect(hl.requestSettlementSignature(req)).rejects.toThrow(/success=false/);
  });
});

describe('HighLevelClient.verifySignedDocument', () => {
  const signedDoc = (over: Record<string, unknown> = {}) => ({
    _id: '65f0a1b2c3d4e5f6a7b8c9d0',
    documentId: 'doc-uuid',
    name: 'Settlement Agreement',
    deleted: false,
    isExpired: false,
    status: 'completed',
    recipients: [
      { id: 'contact_1', role: 'signer', hasCompleted: true, signedDate: '2026-10-20T15:04:05.000Z', ip: '203.0.113.9' },
      { id: 'user_hl', role: 'signer', hasCompleted: true, signedDate: '2026-10-20T16:00:00.000Z', ip: '198.51.100.1' },
    ],
    links: [{ documentId: 'doc-uuid', referenceId: 'ref-claimant' }],
    ...over,
  });
  const other = (n: number) => ({ _id: `other${n}`, documentId: `other-${n}`, status: 'completed', recipients: [], links: [] });
  const ref: { documentId: string | null; referenceId: string | null } = { documentId: 'doc-uuid', referenceId: 'ref-claimant' };

  const verify = async (documents: unknown[], r = ref, contactId = 'contact_1') => {
    const { hl, calls } = client({
      'GET /proposals/document': (c) => {
        const statuses = c.query.get('status')!.split(',');
        const docs = documents.filter((d: any) => statuses.includes(Array.isArray(d.status) ? d.status[0] : d.status));
        return { json: { documents: docs, total: docs.length } };
      },
    });
    return { result: await hl.verifySignedDocument(r, contactId), calls };
  };

  it('signed: completed, every signer has signed, the contact among them', async () => {
    const { result, calls } = await verify([other(1), signedDoc()]);
    expect(result).toEqual({ signed: true, reason: null, signedAt: '2026-10-20T15:04:05.000Z', signerIp: '203.0.113.9', documentName: 'Settlement Agreement' });
    expect(calls[0]!.query.get('locationId')).toBe(LOC);
    expect(calls[0]!.query.get('status')).toBe('completed');
    expect(calls[0]!.headers.get('version')).toBe('2021-07-28');
  });

  it('matches on _id, documentId or links[].referenceId alone; status may be an array', async () => {
    expect((await verify([signedDoc()], { documentId: null, referenceId: 'ref-claimant' })).result.signed).toBe(true);
    expect((await verify([signedDoc()], { documentId: '65f0a1b2c3d4e5f6a7b8c9d0', referenceId: null })).result.signed).toBe(true);
    expect((await verify([signedDoc({ documentId: 'x', links: [{ documentId: 'doc-uuid' }] })], { documentId: 'doc-uuid', referenceId: null })).result.signed).toBe(true);
    expect((await verify([signedDoc({ status: ['completed'] })])).result.signed).toBe(true);
  });

  it('pages through the list with skip', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => other(i));
    const { hl, calls } = client({
      'GET /proposals/document': [() => ({ json: { documents: page1, total: 51 } }), () => ({ json: { documents: [signedDoc()], total: 51 } })],
    });
    expect((await hl.verifySignedDocument(ref, 'contact_1')).signed).toBe(true);
    expect(calls.map((c) => [c.query.get('skip'), c.query.get('limit')])).toEqual([
      ['0', '50'],
      ['50', '50'],
    ]);
  });

  it('manual "Mark as Completed" without signedDate is not signed', async () => {
    const doc = signedDoc({ recipients: [{ id: 'contact_1', role: 'signer', hasCompleted: true, signedDate: null }] });
    expect((await verify([doc])).result).toMatchObject({ signed: false, reason: 'missing_signatures' });
    const noFlag = signedDoc({ recipients: [{ id: 'contact_1', role: 'signer', hasCompleted: false, signedDate: '2026-10-20T15:04:05Z' }] });
    expect((await verify([noFlag])).result).toMatchObject({ signed: false, reason: 'missing_signatures' });
    const badDate = signedDoc({ recipients: [{ id: 'contact_1', role: 'signer', hasCompleted: true, signedDate: 'not a date' }] });
    expect((await verify([badDate])).result).toMatchObject({ signed: false, reason: 'missing_signatures' });
  });

  it('another signer not finished is not signed', async () => {
    const doc = signedDoc({
      recipients: [
        { id: 'contact_1', role: 'signer', hasCompleted: true, signedDate: '2026-10-20T15:04:05Z' },
        { id: 'co_signer', hasCompleted: false, signedDate: null },
      ],
    });
    expect((await verify([doc])).result).toMatchObject({ signed: false, reason: 'missing_signatures' });
  });

  it('expired or deleted is not signed', async () => {
    expect((await verify([signedDoc({ isExpired: true })])).result).toMatchObject({ signed: false, reason: 'expired', documentName: 'Settlement Agreement' });
    expect((await verify([signedDoc({ deleted: true })])).result).toMatchObject({ signed: false, reason: 'deleted' });
  });

  it('a document signed by someone else is not signed for this contact', async () => {
    expect((await verify([signedDoc()], ref, 'contact_2')).result).toMatchObject({ signed: false, reason: 'wrong_signer' });
  });

  it('a sent but unsigned document is not_completed; an unknown one not_found', async () => {
    const sent = signedDoc({ status: 'sent', recipients: [{ id: 'contact_1', role: 'signer', hasCompleted: false }] });
    const r1 = await verify([sent]);
    expect(r1.result).toMatchObject({ signed: false, reason: 'not_completed' });
    expect(r1.calls.map((c) => c.query.get('status'))).toEqual(['completed', 'draft,sent,viewed,accepted']);
    expect((await verify([other(1)])).result).toMatchObject({ signed: false, reason: 'not_found' });
    const none = await verify([signedDoc()], { documentId: null, referenceId: null });
    expect(none.result).toMatchObject({ signed: false, reason: 'not_found' });
    expect(none.calls).toHaveLength(0);
  });
});

describe('formatting helpers', () => {
  it('formats amounts, phones and the From header', () => {
    expect(formatUsd(12500)).toBe('$12,500.00');
    expect(formatUsd(99.5)).toBe('$99.50');
    expect(toE164('+1 (603) 555-0100')).toBe('+16035550100');
    expect(toE164('603-555-0100')).toBe('+16035550100');
    expect(toE164('16035550100')).toBe('+16035550100');
    expect(toE164('555-0100')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(formatFrom('Home Delivery Claims', 'claims@x.test')).toBe('Home Delivery Claims <claims@x.test>');
    expect(formatFrom('Claims, Inc.', 'claims@x.test')).toBe('"Claims, Inc." <claims@x.test>');
    expect(formatFrom('Evil\r\nBcc: x', 'claims@x.test')).toBe('"EvilBcc: x" <claims@x.test>');
    expect(formatFrom('', 'claims@x.test')).toBe('claims@x.test');
  });
});
