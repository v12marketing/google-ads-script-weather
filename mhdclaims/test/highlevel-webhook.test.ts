import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HIGHLEVEL_WORKFLOW_CUSTOM_DATA,
  emailToText,
  normaliseChannel,
  parseHighLevelWebhook,
  verifyHighLevelSignature,
} from '../src/adapters/highlevel/webhook.js';
import { testConfig } from '../src/config.js';

const inboundSms = {
  type: 'InboundMessage',
  locationId: 'l1C08ntBrFjLS0elLIYU',
  attachments: [],
  body: 'Any update on my claim?',
  contactId: 'cI08i1Bls3iTB9bKgFJh',
  contentType: 'text/plain',
  conversationId: 'fcanlLgpbQgQhderivVs',
  dateAdded: '2021-04-21T11:31:45.750Z',
  direction: 'inbound',
  messageType: 'SMS',
  messageId: 'msgA1b2C3',
  status: 'delivered',
};

describe('parseHighLevelWebhook: marketplace InboundMessage', () => {
  it('parses an inbound SMS', () => {
    expect(parseHighLevelWebhook(inboundSms)).toEqual({
      kind: 'inbound_message',
      contactId: 'cI08i1Bls3iTB9bKgFJh',
      channel: 'sms',
      body: 'Any update on my claim?',
      messageId: 'msgA1b2C3',
      subject: null,
    });
  });

  it('parses an inbound email, keeping only the new reply text', () => {
    const ev = parseHighLevelWebhook({
      ...inboundSms,
      messageType: 'Email',
      subject: 'Re: Your claim HDC-000123',
      to: ['claims@claims.test'],
      body:
        '<div dir="ltr">Thanks &amp; regards,<br>here are the photos.</div><br>' +
        '<div class="gmail_quote"><div>On Mon, Oct 20, 2026 at 9:00 AM Claims &lt;claims@claims.test&gt; wrote:</div>' +
        '<blockquote>Your claim portal: https://claims.test/c/abc</blockquote></div>',
    });
    expect(ev).toEqual({
      kind: 'inbound_message',
      contactId: 'cI08i1Bls3iTB9bKgFJh',
      channel: 'email',
      body: 'Thanks & regards,\nhere are the photos.',
      messageId: 'msgA1b2C3',
      subject: 'Re: Your claim HDC-000123',
    });
  });

  it('ignores outbound messages, other events and other channels', () => {
    expect(parseHighLevelWebhook({ ...inboundSms, direction: 'outbound' })).toBeNull();
    expect(parseHighLevelWebhook({ ...inboundSms, type: 'OutboundMessage' })).toBeNull();
    expect(parseHighLevelWebhook({ ...inboundSms, type: 'ContactDndUpdate' })).toBeNull();
    expect(parseHighLevelWebhook({ ...inboundSms, messageType: 'CALL' })).toBeNull();
    expect(parseHighLevelWebhook({ ...inboundSms, messageType: 'FB' })).toBeNull();
  });

  it('ignores events without a usable contact or body', () => {
    expect(parseHighLevelWebhook({ ...inboundSms, contactId: undefined })).toBeNull();
    expect(parseHighLevelWebhook({ ...inboundSms, contactId: '../../contacts/x' })).toBeNull();
    expect(parseHighLevelWebhook({ ...inboundSms, body: '   ' })).toBeNull();
    expect(parseHighLevelWebhook({ ...inboundSms, body: 42 })).toBeNull();
  });

  it('rejects non-object bodies', () => {
    for (const b of [null, undefined, 'x', 1, [], [inboundSms]]) expect(parseHighLevelWebhook(b)).toBeNull();
  });
});

describe('parseHighLevelWebhook: workflow Webhook action', () => {
  // Standard workflow payload: contact fields, location, custom data flattened in.
  const standard = {
    contact_id: 'cI08i1Bls3iTB9bKgFJh',
    first_name: 'Jane',
    last_name: 'Doe',
    full_name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+16035550100',
    tags: 'hdc-claimant',
    location: { id: 'loc_test', name: 'Claims' },
    workflow: { id: 'wf1', name: 'Customer replied' },
  };

  it('documents the custom data keys staff configure', () => {
    expect(Object.keys(HIGHLEVEL_WORKFLOW_CUSTOM_DATA)).toEqual(['hdc_event', 'contact_id', 'claim_number', 'message_body', 'message_type', 'message_id']);
    expect(HIGHLEVEL_WORKFLOW_CUSTOM_DATA.contact_id).toBe('{{contact.id}}');
  });

  it('parses an inbound SMS with custom data at the top level', () => {
    const ev = parseHighLevelWebhook({
      ...standard,
      hdc_event: 'inbound_message',
      claim_number: 'HDC-000123',
      message_body: 'STATUS',
      message_type: 'SMS',
      message_id: 'm123',
    });
    expect(ev).toEqual({ kind: 'inbound_message', contactId: 'cI08i1Bls3iTB9bKgFJh', channel: 'sms', body: 'STATUS', messageId: 'm123', subject: null });
  });

  it('parses an inbound email with custom data under customData', () => {
    const ev = parseHighLevelWebhook({
      ...standard,
      contact_id: undefined,
      customData: {
        hdc_event: 'inbound_message',
        contact_id: 'cI08i1Bls3iTB9bKgFJh',
        message_body: 'New text\n\nOn Tue, Oct 21, 2026 at 10:00 AM Claims <claims@claims.test> wrote:\n> old text',
        message_type: 'TYPE_EMAIL',
        message_id: '{{message.id}}',
      },
      message: { subject: 'Re: claim' },
    });
    expect(ev).toEqual({ kind: 'inbound_message', contactId: 'cI08i1Bls3iTB9bKgFJh', channel: 'email', body: 'New text', messageId: null, subject: 'Re: claim' });
  });

  it('falls back to the standard message object', () => {
    const ev = parseHighLevelWebhook({ ...standard, customData: { hdc_event: 'inbound_message' }, message: { type: 'SMS', body: 'Hello', id: 'mid9' } });
    expect(ev).toMatchObject({ channel: 'sms', body: 'Hello', messageId: 'mid9' });
    // Unrendered merge tags in custom data also fall back.
    const ev2 = parseHighLevelWebhook({
      ...standard,
      customData: { hdc_event: 'inbound_message', message_type: '{{message.type}}', message_body: '{{message.body}}' },
      message: { type: 'Email', body: '<p>Photos attached</p>' },
    });
    expect(ev2).toMatchObject({ channel: 'email', body: 'Photos attached' });
  });

  it('ignores inbound messages on other channels or without a body/contact', () => {
    const base = { ...standard, hdc_event: 'inbound_message', message_body: 'Hi' };
    expect(parseHighLevelWebhook({ ...base, message_type: 'Facebook' })).toBeNull();
    expect(parseHighLevelWebhook({ ...base })).toBeNull();
    expect(parseHighLevelWebhook({ ...base, message_type: 'SMS', message_body: '{{message.body}}' })).toBeNull();
    expect(parseHighLevelWebhook({ ...base, message_type: 'SMS', contact_id: '' })).toBeNull();
  });

  it('parses document signed and declined', () => {
    expect(parseHighLevelWebhook({ ...standard, customData: { hdc_event: 'document_signed', contact_id: 'cI08i1Bls3iTB9bKgFJh', claim_number: 'hdc-000123' } })).toEqual({
      kind: 'document_signed',
      contactId: 'cI08i1Bls3iTB9bKgFJh',
      documentId: null,
      claimNumber: 'HDC-000123',
    });
    expect(parseHighLevelWebhook({ ...standard, hdc_event: 'Document_Declined', claim_number: 'HDC-000123' })).toEqual({
      kind: 'document_declined',
      contactId: 'cI08i1Bls3iTB9bKgFJh',
      claimNumber: 'HDC-000123',
    });
  });

  it('treats unrendered merge tags and malformed values as missing', () => {
    expect(parseHighLevelWebhook({ hdc_event: 'document_signed', contact_id: '{{contact.id}}', claim_number: '{{contact.claim_number}}' })).toEqual({
      kind: 'document_signed',
      contactId: null,
      documentId: null,
      claimNumber: null,
    });
    expect(parseHighLevelWebhook({ hdc_event: 'document_signed', contact_id: 'a b', claim_number: 'HDC 1; drop' })).toMatchObject({ contactId: null, claimNumber: null });
  });

  it('ignores unknown hdc_event values', () => {
    expect(parseHighLevelWebhook({ ...standard, hdc_event: 'payment_sent' })).toBeNull();
  });
});

describe('channel and email helpers', () => {
  it('normalises channels', () => {
    expect(normaliseChannel('SMS')).toBe('sms');
    expect(normaliseChannel('TYPE_SMS')).toBe('sms');
    expect(normaliseChannel('Email')).toBe('email');
    expect(normaliseChannel(3)).toBe('email');
    expect(normaliseChannel('CALL')).toBeNull();
    expect(normaliseChannel(undefined)).toBeNull();
  });

  it('strips Outlook-style quoted history and keeps plain text with angle brackets', () => {
    expect(emailToText('Sounds good\n\nFrom: Claims <claims@claims.test>\nSent: Monday\nSubject: Claim')).toBe('Sounds good');
    expect(emailToText('Amount was < $500 and > $100')).toBe('Amount was < $500 and > $100');
    expect(emailToText('> only quoted')).toBe('> only quoted');
    expect(emailToText('<p>Hi&nbsp;there &#8212; ok</p><script>alert(1)</script>')).toBe('Hi there — ok');
  });
});

describe('verifyHighLevelSignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = JSON.stringify(inboundSms);
  const sig = sign(null, Buffer.from(raw), privateKey).toString('base64');

  it('accepts a valid signature with a PEM, base64 DER or raw 32-byte key', () => {
    expect(verifyHighLevelSignature(raw, sig, pem)).toBe(true);
    expect(verifyHighLevelSignature(raw, sig, der.toString('base64'))).toBe(true);
    expect(verifyHighLevelSignature(raw, sig, der.subarray(12).toString('base64'))).toBe(true);
    expect(verifyHighLevelSignature(Buffer.from(raw), sig, pem)).toBe(true);
  });

  it('rejects a tampered body, a missing or malformed signature, and the wrong key', () => {
    expect(verifyHighLevelSignature(raw.replace('Any update', 'Any updatf'), sig, pem)).toBe(false);
    expect(verifyHighLevelSignature(raw, undefined, pem)).toBe(false);
    expect(verifyHighLevelSignature(raw, '', pem)).toBe(false);
    expect(verifyHighLevelSignature(raw, 'not-base64!!', pem)).toBe(false);
    expect(verifyHighLevelSignature(raw, sig.slice(0, 40), pem)).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyHighLevelSignature(raw, sig, other)).toBe(false);
    // HighLevel's published key (the config default) parses and rejects our signature.
    expect(verifyHighLevelSignature(raw, sig, testConfig().HIGHLEVEL_WEBHOOK_PUBLIC_KEY)).toBe(false);
  });

  it('rejects unusable or non-Ed25519 keys without throwing', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyHighLevelSignature(raw, sig, rsa)).toBe(false);
    expect(verifyHighLevelSignature(raw, sig, 'garbage')).toBe(false);
    expect(verifyHighLevelSignature(raw, sig, '')).toBe(false);
  });
});
