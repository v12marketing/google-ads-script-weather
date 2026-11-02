import { describe, expect, it } from 'vitest';
import { EVENT_TEMPLATE_KEYS, STATUS_KEYS, type Claim, type TemplateVars } from '../src/domain/types.js';
import type { PaymentService } from '../src/services/contracts.js';
import { renderEmailHtml, renderEmailText } from '../src/services/email-html.js';
import { DEFAULT_TEMPLATES, TEMPLATE_VAR_NAMES, formatDate, formatMoney } from '../src/services/templates.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let seq = 5000;
function makeClaim(env: TestEnv, o: Partial<Parameters<TestEnv['ctx']['repo']['createClaim']>[0]> = {}): Claim {
  const { tokens } = env.ctx.services;
  return env.ctx.repo.createClaim(
    {
      itemId: String(seq++),
      claimantName: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      statusKey: 'under_review',
      statusLabel: 'Under review',
      amountClaimed: 1250,
      // 10pm on October 22 in New York.
      receivedAt: '2026-10-23T02:00:00.000Z',
      ...o,
    },
    (id, v) => tokens.tokenHash(tokens.portalToken(id, v)),
  ).claim;
}

const paymentStub = (url: string): PaymentService => ({
  paymentFormUrl: () => url,
  paymentSignature: () => 'sig',
  handlePaymentItemCreated: async () => {},
});

const LONG_VARS: TemplateVars = {
  firstName: 'Bartholomew',
  claimantName: 'Bartholomew Featherstonehaugh',
  claimNumber: 'HDC-000123',
  portalUrl: `https://homedeliveryclaims.com/c/${'A'.repeat(43)}`,
  statusLabel: 'More information needed',
  dateReceived: 'September 30, 2026',
  amountClaimed: '$12,345.67',
  settlementAmount: '$9,876.54',
  paymentFormUrl: `https://forms.monday.com/forms/paymentform?r=use1&claim=HDC-000123&ref=${'b'.repeat(43)}`,
  message: 'A message',
  code: '123456',
  claimList: 'HDC-000123',
};

const ALL_KEYS = [...STATUS_KEYS, ...EVENT_TEMPLATE_KEYS];

describe('template rendering', () => {
  const env = makeTestEnv();
  const { templates } = env.ctx.services;

  it('substitutes placeholders, tolerating whitespace, and blanks unknown ones', () => {
    const vars = { ...LONG_VARS, firstName: 'Jane' };
    expect(templates.render('Hi {{firstName}}, {{ claimNumber }} / {{  code}}.', vars)).toBe('Hi Jane, HDC-000123 / 123456.');
    expect(templates.render('[{{nope}}][{{ constructor }}][{{__proto__}}][{{}}]', vars)).toBe('[][][][]');
    expect(templates.render('no placeholders', vars)).toBe('no placeholders');
  });

  it('never expands placeholders inside substituted values', () => {
    const vars = { ...LONG_VARS, message: 'my code is {{code}} and {{portalUrl}}' };
    expect(templates.render('{{message}}', vars)).toBe('my code is {{code}} and {{portalUrl}}');
  });
});

describe('default templates', () => {
  const env = makeTestEnv();
  const { templates } = env.ctx.services;

  it('has one template for every status and event key', () => {
    expect(Object.keys(DEFAULT_TEMPLATES).sort()).toEqual([...ALL_KEYS].sort());
    for (const key of ALL_KEYS) expect(DEFAULT_TEMPLATES[key].key).toBe(key);
    for (const key of STATUS_KEYS) {
      const t = DEFAULT_TEMPLATES[key];
      expect(t.emailSubject.trim(), key).not.toBe('');
      expect(t.emailBody.trim(), key).not.toBe('');
      expect(t.sms.trim(), key).not.toBe('');
      expect(t.portalText.trim(), key).not.toBe('');
    }
    for (const key of EVENT_TEMPLATE_KEYS) expect(DEFAULT_TEMPLATES[key].portalText, key).toBe('');
  });

  it('puts the claim number and the private link with a do-not-forward note in every email', () => {
    for (const key of ALL_KEYS) {
      const t = DEFAULT_TEMPLATES[key];
      if (!t.emailBody) continue;
      if (key === 'claim_links') {
        expect(t.emailBody).toContain('{{claimList}}');
      } else if (key === 'login_code') {
        // The code only works in the browser that asked for it, so its email
        // carries no claim link to open the page somewhere else.
        expect(t.emailSubject, key).toContain('{{claimNumber}}');
        expect(t.emailBody, key).not.toContain('{{portalUrl}}');
        expect(t.emailBody, key).toMatch(/don't share it/);
        continue;
      } else {
        expect(t.emailSubject, key).toContain('{{claimNumber}}');
        expect(t.emailBody, key).toContain('{{claimNumber}}');
        expect(t.emailBody, key).toContain('{{portalUrl}}');
      }
      expect(t.emailBody, key).toMatch(/don't forward this email/);
    }
  });

  it('keeps amounts out of email and SMS, and other brands out of everything', () => {
    for (const key of ALL_KEYS) {
      const t = DEFAULT_TEMPLATES[key];
      const sent = `${t.emailSubject}\n${t.emailBody}\n${t.sms}`;
      expect(sent, key).not.toMatch(/settlementAmount|amountClaimed|\$\d/);
      expect(`${sent}\n${t.portalText}`, key).not.toMatch(/\b(aria|v12|monday)\b/i);
    }
  });

  it('uses only known variables', () => {
    for (const key of ALL_KEYS) {
      const t = DEFAULT_TEMPLATES[key];
      for (const m of `${t.emailSubject} ${t.emailBody} ${t.sms} ${t.portalText}`.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
        expect(TEMPLATE_VAR_NAMES, `${key}: ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('keeps SMS short, identifies the sender and carries opt-out language on the confirmation', () => {
    for (const key of ALL_KEYS) {
      const sms = templates.render(DEFAULT_TEMPLATES[key].sms, LONG_VARS);
      if (!sms) continue;
      expect(sms.length, key).toBeLessThanOrEqual(300);
      expect(sms, key).toMatch(/^Home Delivery Claims/);
      expect(sms, key).not.toContain('{{');
    }
    expect(DEFAULT_TEMPLATES.confirmation.sms.endsWith('Reply STOP to opt out, HELP for help.')).toBe(true);
    expect(DEFAULT_TEMPLATES.login_code.sms).toBe('');
    expect(DEFAULT_TEMPLATES.claim_links.sms).toBe('');
  });

  it('covers the specific content each message needs', () => {
    const d = DEFAULT_TEMPLATES;
    expect(d.confirmation.emailBody).toContain('{{dateReceived}}');
    expect(d.received.emailBody).toContain('{{dateReceived}}');
    expect(d.more_info_needed.emailBody).toMatch(/message/);
    expect(d.more_info_needed.emailBody).toMatch(/documents/);
    expect(d.settlement_offered.emailBody).toMatch(/sign it electronically/);
    expect(d.settlement_offered.emailBody).toMatch(/claim page/);
    expect(d.settlement_signed.emailBody).toContain('{{paymentFormUrl}}');
    expect(d.settlement_signed.emailBody).toMatch(/mailed check/);
    expect(d.settlement_signed.emailBody).toMatch(/direct deposit \(ACH\)/);
    expect(d.denied.emailBody).toMatch(/reply to this email/);
    expect(d.new_message.emailBody).toContain('You have a new message about claim {{claimNumber}}');
    expect(d.new_message.emailBody).toContain('{{message}}');
    expect(d.login_code.emailBody).toContain('{{code}}');
    expect(d.login_code.emailBody).toMatch(/10 minutes/);
    expect(d.login_code.emailBody).toMatch(/don't share/);
    expect(d.status_reply.emailSubject + d.status_reply.emailBody).toBe('');
    expect(templates.render(d.status_reply.sms, LONG_VARS)).toBe(
      `Home Delivery Claims: Claim HDC-000123: More information needed. Details: ${LONG_VARS.portalUrl}`,
    );
  });
});

describe('template vars', () => {
  it('builds every variable from the claim', () => {
    const env = makeTestEnv();
    env.ctx.services.payment = paymentStub('https://forms.example.test/pay?claim=HDC-000001&ref=x');
    const claim = makeClaim(env);
    env.ctx.repo.updateClaim(claim.itemId, { settlementAmount: 980.5 });
    const v = env.ctx.services.templates.vars(env.ctx.repo.getClaim(claim.itemId)!, { message: 'Hello', code: undefined });
    expect(v).toEqual({
      firstName: 'Jane',
      claimantName: 'Jane Doe',
      claimNumber: claim.claimNumber,
      portalUrl: env.ctx.services.tokens.portalUrl(claim),
      statusLabel: 'Under review',
      dateReceived: 'October 22, 2026',
      amountClaimed: '$1,250.00',
      settlementAmount: '$980.50',
      paymentFormUrl: 'https://forms.example.test/pay?claim=HDC-000001&ref=x',
      message: 'Hello',
      code: '',
      claimList: '',
    });
  });

  it('falls back gracefully for missing data and an unavailable payment form', () => {
    const env = makeTestEnv();
    env.ctx.services.payment = new Proxy({} as PaymentService, {
      get: () => () => {
        throw new Error('not configured');
      },
    });
    const claim = makeClaim(env, { firstName: '  ', amountClaimed: null, statusLabel: null, statusKey: 'payment_sent' });
    const v = env.ctx.services.templates.vars(claim);
    expect(v.firstName).toBe('there');
    expect(v.amountClaimed).toBe('');
    expect(v.settlementAmount).toBe('');
    expect(v.paymentFormUrl).toBe('');
    expect(v.statusLabel).toBe('Payment sent');
  });

  it('formats dates and money for US readers', () => {
    expect(formatDate('2026-01-05T15:00:00Z')).toBe('January 5, 2026');
    expect(formatDate('not a date')).toBe('');
    expect(formatMoney(1250)).toBe('$1,250.00');
    expect(formatMoney(0.5)).toBe('$0.50');
    expect(formatMoney(null)).toBe('');
  });
});

describe('template overrides', () => {
  it('saves, reads back and resets an override', () => {
    const env = makeTestEnv();
    const { templates } = env.ctx.services;
    templates.save(
      { key: 'closed', emailSubject: ' Closed:\n{{claimNumber}} ', emailBody: 'Bye\r\n{{portalUrl}}', sms: 'Short', portalText: 'Done.' },
      'admin',
    );
    expect(templates.get('closed')).toEqual({
      key: 'closed',
      emailSubject: 'Closed: {{claimNumber}}',
      emailBody: 'Bye\n{{portalUrl}}',
      sms: 'Short',
      portalText: 'Done.',
    });
    expect(templates.getDefault('closed')).toEqual(DEFAULT_TEMPLATES.closed);
    templates.reset('closed');
    expect(templates.get('closed')).toEqual(DEFAULT_TEMPLATES.closed);
  });

  it('keeps email-only templates off SMS and portal text off event templates', () => {
    const env = makeTestEnv();
    const { templates } = env.ctx.services;
    templates.save({ key: 'login_code', emailSubject: 'Code', emailBody: '{{code}}', sms: 'Your code {{code}}', portalText: 'x' }, 'admin');
    expect(templates.get('login_code').sms).toBe('');
    expect(templates.get('login_code').portalText).toBe('');
  });

  it('rejects unknown keys and oversized fields', () => {
    const env = makeTestEnv();
    const { templates } = env.ctx.services;
    expect(() => templates.get('nope' as never)).toThrow(/Unknown template key/);
    expect(() =>
      templates.save({ key: 'closed', emailSubject: 'x'.repeat(201), emailBody: '', sms: '', portalText: '' }, 'admin'),
    ).toThrow(/longer than/);
  });

  it('returns copies, so callers cannot mutate the defaults', () => {
    const env = makeTestEnv();
    const t = env.ctx.services.templates.get('received');
    t.sms = 'changed';
    expect(DEFAULT_TEMPLATES.received.sms).not.toBe('changed');
  });
});

describe('email rendering', () => {
  const portalUrl = `https://claims.test/c/${'Z'.repeat(43)}`;

  it('escapes content, links URLs and turns a lone claim link into a button', () => {
    const out = renderEmailHtml({
      subject: 'Claim <HDC-000001> & "you"',
      bodyText: `Hi <script>alert("x")</script> & co,\n\nSee https://example.com/a?b=1&c=2. Thanks\n\nYour claim page:\n${portalUrl}\n\nBad: https://x.test/"onmouseover="alert(1)`,
      claimNumber: 'HDC-000001',
      linkPrefixes: ['https://claims.test', 'https://example.com/'],
    });
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).not.toContain('<script>');
    expect(out).toContain('Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co,');
    expect(out).toContain('<title>Claim &lt;HDC-000001&gt; &amp; &quot;you&quot;</title>');
    expect(out).toContain('<a href="https://example.com/a?b=1&amp;c=2" ');
    expect(out).toContain('>https://example.com/a?b=1&amp;c=2</a>. Thanks');
    expect(out).toMatch(new RegExp(`<a href="${portalUrl}"[^>]*>View your claim</a>`));
    expect(out).not.toContain('onmouseover="');
    expect(out).toContain('Home Delivery Claims');
    expect(out).toContain('You&#39;re receiving this because you filed claim HDC-000001 with Home Delivery Claims.');
  });

  it('renders listed button URLs and login codes, and keeps inline claim links as links', () => {
    const pay = 'https://forms.example.test/pay?claim=HDC-000001&ref=abc';
    const out = renderEmailHtml({
      subject: 's',
      bodyText: `Pay here:\n${pay}\n\n123456\n\nInline ${portalUrl} link`,
      claimNumber: 'HDC-000001',
      buttons: [{ url: pay, label: 'Choose how to be paid' }],
      linkPrefixes: ['https://claims.test', 'https://forms.example.test/pay'],
    });
    expect(out).toContain('>Choose how to be paid</a>');
    expect(out).toMatch(/letter-spacing:6px;[^>]*>123456<\/p>/);
    expect(out).not.toContain('View your claim');
    expect(out).toContain(`Inline <a href="${portalUrl}"`);
  });

  it('produces a plain-text version with the same footer', () => {
    const text = renderEmailText({ subject: 's', bodyText: 'Hello\r\n\r\nWorld\n', claimNumber: 'HDC-000002' });
    expect(text).toBe(
      "Hello\n\nWorld\n\n--\nYou're receiving this because you filed claim HDC-000002 with Home Delivery Claims.\nReplies to this email go to our claims team.\n",
    );
  });
});
