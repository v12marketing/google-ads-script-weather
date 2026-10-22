import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { htmlToText, parseMondayWebhook, verifyMondayAuthorization } from '../src/adapters/monday/webhook.js';

const base = { boardId: 1234567890, pulseId: 1772099344, triggerUuid: 'b6c0e3c4f1d2', userId: 9603417 };

describe('parseMondayWebhook', () => {
  it('returns the challenge', () => {
    expect(parseMondayWebhook({ challenge: 'abc123' })).toEqual({ challenge: 'abc123' });
  });

  it('parses create_item (delivered as create_pulse) with numeric ids normalised', () => {
    const body = { event: { ...base, type: 'create_pulse', pulseName: 'Jane Doe', groupId: 'topics', columnValues: {} } };
    expect(parseMondayWebhook(body)).toEqual({
      event: { kind: 'item_created', boardId: '1234567890', itemId: '1772099344', triggerUuid: 'b6c0e3c4f1d2' },
    });
    expect(parseMondayWebhook({ event: { ...base, type: 'create_item' } })).toMatchObject({ event: { kind: 'item_created' } });
  });

  it('parses a status change (update_column_value on a color column)', () => {
    const body = {
      event: {
        ...base,
        type: 'update_column_value',
        columnId: 'status',
        columnType: 'color',
        columnTitle: 'Status',
        value: { label: { index: 1, text: 'Settlement offered', style: { color: '#00c875' }, is_done: false }, post_id: null },
        previousValue: { label: { index: 0, text: 'Under review' } },
        changedAt: 1729580000.123,
      },
    };
    expect(parseMondayWebhook(body)).toEqual({
      event: {
        kind: 'status_changed',
        boardId: '1234567890',
        itemId: '1772099344',
        columnId: 'status',
        label: 'Settlement offered',
        previousLabel: 'Under review',
        triggerUuid: 'b6c0e3c4f1d2',
      },
    });
  });

  it('treats a cleared status and a null previousValue as null labels', () => {
    const body = { event: { ...base, type: 'update_column_value', columnId: 'status', columnType: 'status', value: null, previousValue: null } };
    expect(parseMondayWebhook(body)).toMatchObject({ event: { kind: 'status_changed', label: null, previousLabel: null } });
    const blank = { event: { ...base, type: 'change_status_column_value', columnId: 'status', value: { label: { index: 5, text: '' } } } };
    expect(parseMondayWebhook(blank)).toMatchObject({ event: { kind: 'status_changed', label: null } });
  });

  it('detects a status change from the label shape when columnType is missing', () => {
    const body = { event: { ...base, type: 'update_column_value', columnId: 'status', value: '{"label":{"index":2,"text":"Closed"}}' } };
    expect(parseMondayWebhook(body)).toMatchObject({ event: { kind: 'status_changed', label: 'Closed' } });
  });

  it('parses a file column change as column_changed', () => {
    for (const type of ['update_column_value', 'change_specific_column_value', 'change_column_value']) {
      const body = { event: { ...base, type, columnId: 'file_shared_documents', columnType: 'file', value: { files: [] } } };
      expect(parseMondayWebhook(body)).toEqual({
        event: { kind: 'column_changed', boardId: '1234567890', itemId: '1772099344', columnId: 'file_shared_documents', triggerUuid: 'b6c0e3c4f1d2' },
      });
    }
  });

  it('parses create_update with textBody', () => {
    const body = {
      event: { ...base, type: 'create_update', body: '<p>To claimant: hello</p>', textBody: 'To claimant: hello', updateId: 618366906, replyId: null, app: 'monday' },
    };
    expect(parseMondayWebhook(body)).toEqual({
      event: {
        kind: 'update_created',
        boardId: '1234567890',
        itemId: '1772099344',
        updateId: '618366906',
        textBody: 'To claimant: hello',
        creatorId: '9603417',
        triggerUuid: 'b6c0e3c4f1d2',
      },
    });
  });

  it('strips HTML when an update has only a body', () => {
    const body = { event: { ...base, type: 'create_update', body: '<p>To claimant: a &amp; b</p><p>Line&nbsp;2<br>3</p>', updateId: '5' } };
    expect(parseMondayWebhook(body)).toMatchObject({ event: { kind: 'update_created', updateId: '5', textBody: 'To claimant: a & b\nLine 2\n3' } });
  });

  it('dedupes replies on the reply id', () => {
    const body = { event: { ...base, type: 'create_update', textBody: 'To claimant: re', updateId: 100, replyId: 101 } };
    expect(parseMondayWebhook(body)).toMatchObject({ event: { kind: 'update_created', updateId: '101' } });
  });

  it('ignores what it cannot use', () => {
    expect(parseMondayWebhook(null)).toHaveProperty('ignore');
    expect(parseMondayWebhook('x')).toHaveProperty('ignore');
    expect(parseMondayWebhook({})).toHaveProperty('ignore');
    expect(parseMondayWebhook({ event: { type: 'create_pulse', boardId: 1 } })).toHaveProperty('ignore');
    expect(parseMondayWebhook({ event: { ...base, pulseId: 'abc', type: 'create_pulse' } })).toHaveProperty('ignore');
    expect(parseMondayWebhook({ event: { ...base, type: 'update_name' } })).toEqual({ ignore: 'unsupported event type update_name' });
    expect(parseMondayWebhook({ event: { ...base, type: 'update_column_value' } })).toHaveProperty('ignore');
    expect(parseMondayWebhook({ event: { ...base, type: 'create_update' } })).toHaveProperty('ignore');
    expect(parseMondayWebhook({ event: { ...base, type: 'create_pulse', parentItemId: '5' } })).toHaveProperty('ignore');
  });

  it('missing triggerUuid becomes null', () => {
    expect(parseMondayWebhook({ event: { boardId: 1, pulseId: 2, type: 'create_pulse' } })).toEqual({
      event: { kind: 'item_created', boardId: '1', itemId: '2', triggerUuid: null },
    });
  });
});

describe('htmlToText', () => {
  it('keeps entities decoded once and drops tags', () => {
    expect(htmlToText('<b>&amp;lt;</b> &#39;x&#39; &quot;y&quot; <script>z</script>')).toBe(`&lt; 'x' "y" z`);
  });
});

const SECRET = 'monday-signing-secret';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const unsigned = `${b64(header)}.${b64(claims)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);

describe('verifyMondayAuthorization', () => {
  it('passes everything when no secret is configured', () => {
    expect(verifyMondayAuthorization(undefined, undefined)).toBe(true);
    expect(verifyMondayAuthorization('garbage', '')).toBe(true);
  });

  it('requires the header when a secret is configured', () => {
    expect(verifyMondayAuthorization(undefined, SECRET)).toBe(false);
    expect(verifyMondayAuthorization('', SECRET)).toBe(false);
  });

  it('accepts a valid token, with or without Bearer', () => {
    const token = jwt({ accountId: 1, userId: 2, aud: 'https://claims.test/webhooks/monday/x', iat: now(), exp: now() + 60 });
    expect(verifyMondayAuthorization(token, SECRET)).toBe(true);
    expect(verifyMondayAuthorization(`Bearer ${token}`, SECRET)).toBe(true);
    expect(verifyMondayAuthorization(jwt({ accountId: 1 }), SECRET)).toBe(true); // no exp
  });

  it('rejects a bad signature, wrong secret or tampered payload', () => {
    const token = jwt({ accountId: 1, exp: now() + 60 });
    expect(verifyMondayAuthorization(jwt({ accountId: 1, exp: now() + 60 }, 'other-secret'), SECRET)).toBe(false);
    const [h, , s] = token.split('.');
    expect(verifyMondayAuthorization(`${h}.${b64({ accountId: 666, exp: now() + 60 })}.${s}`, SECRET)).toBe(false);
    expect(verifyMondayAuthorization(`${token}x`, SECRET)).toBe(false);
    expect(verifyMondayAuthorization(token.slice(0, -2), SECRET)).toBe(false);
    expect(verifyMondayAuthorization('a.b', SECRET)).toBe(false);
    expect(verifyMondayAuthorization('a.b.c=', SECRET)).toBe(false);
  });

  it('rejects other algorithms, including none', () => {
    expect(verifyMondayAuthorization(jwt({ accountId: 1 }, SECRET, { alg: 'HS512' }), SECRET)).toBe(false);
    const unsigned = `${b64({ alg: 'none' })}.${b64({ accountId: 1 })}`;
    expect(verifyMondayAuthorization(`${unsigned}.`, SECRET)).toBe(false);
  });

  it('rejects expired and not-yet-valid tokens (30s skew allowed)', () => {
    expect(verifyMondayAuthorization(jwt({ exp: now() - 120 }), SECRET)).toBe(false);
    expect(verifyMondayAuthorization(jwt({ exp: now() - 10 }), SECRET)).toBe(true);
    expect(verifyMondayAuthorization(jwt({ exp: 'soon' }), SECRET)).toBe(false);
    expect(verifyMondayAuthorization(jwt({ nbf: now() + 300 }), SECRET)).toBe(false);
  });
});
