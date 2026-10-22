import {
  EVENT_TEMPLATE_KEYS,
  STATUS_KEYS,
  type Claim,
  type EventTemplateKey,
  type MessageTemplate,
  type StatusKey,
  type TemplateKey,
  type TemplateVars,
} from '../domain/types.js';
import type { CoreContext, Services, TemplateService } from './contracts.js';

// Default copy for every claimant message. The team can override any of it from
// /admin; overrides live in the templates table and `reset` falls back to these.
// Rules baked into the copy: every email carries the claim number and the private
// claim link with a do-not-forward note; SMS identifies the sender and never
// carries amounts; settlement amounts never appear in email or SMS.

export const ALL_TEMPLATE_KEYS: readonly TemplateKey[] = [...STATUS_KEYS, ...EVENT_TEMPLATE_KEYS];

// Never sent by SMS: the login code proves the claimant reads the claim's email,
// and claim links answer a request made for an email address.
export const EMAIL_ONLY_TEMPLATE_KEYS: ReadonlySet<TemplateKey> = new Set<TemplateKey>(['login_code', 'claim_links']);

export const TEMPLATE_VAR_NAMES: ReadonlyArray<keyof TemplateVars> = [
  'firstName',
  'claimantName',
  'claimNumber',
  'portalUrl',
  'statusLabel',
  'dateReceived',
  'amountClaimed',
  'settlementAmount',
  'paymentFormUrl',
  'message',
  'code',
  'claimList',
];

const PRIVATE_NOTE = "This link is private to you, so please don't forward this email.";
const SIGN_OFF = 'Kind regards,\nThe Home Delivery Claims team';
const claimLink = (lead = 'Your claim page:') => `${lead}\n{{portalUrl}}\n\n${PRIVATE_NOTE}`;
const email = (...paragraphs: string[]) => ['Hi {{firstName}},', ...paragraphs, SIGN_OFF].join('\n\n');

const CONFIRMATION_BODY = email(
  "Thank you for filing your claim with us. We're sorry your delivery arrived damaged, and we're here to help.",
  'Claim number: {{claimNumber}}\nDate received: {{dateReceived}}',
  "A claims specialist will review your details and photos. If we need anything else, we'll let you know. There's nothing you need to do right now.",
  claimLink('You can check your claim, send us a message or add photos at any time on your private claim page:'),
);
const CONFIRMATION_SMS =
  'Home Delivery Claims: We received your claim {{claimNumber}}. Track it, message us or add photos here: {{portalUrl}} Reply STOP to opt out, HELP for help.';

const STATUS_DEFAULTS: Record<StatusKey, Omit<MessageTemplate, 'key'>> = {
  received: {
    emailSubject: "We've received your claim {{claimNumber}}",
    emailBody: CONFIRMATION_BODY,
    sms: CONFIRMATION_SMS,
    portalText:
      "We've received your claim and it's in line for review. A claims specialist will look over your details and photos, and we'll email you as soon as there's news. If you have more photos or documents, you're welcome to add them below.",
  },
  under_review: {
    emailSubject: 'Your claim {{claimNumber}} is being reviewed',
    emailBody: email(
      "A claims specialist is now reviewing your claim {{claimNumber}}. We'll go through your details, photos and any documents you've sent.",
      "If we need anything else from you, we'll let you know. Otherwise, there's nothing you need to do right now.",
      claimLink(),
    ),
    sms: "Home Delivery Claims: Your claim {{claimNumber}} is now being reviewed. We'll be in touch if we need anything. Details: {{portalUrl}}",
    portalText:
      "A claims specialist is reviewing your claim, photos and documents. If we need anything else, we'll post a message here and email you. There's nothing you need to do right now.",
  },
  more_info_needed: {
    emailSubject: 'We need a little more information for claim {{claimNumber}}',
    emailBody: email(
      'To keep your claim {{claimNumber}} moving, we need a little more information from you.',
      'Please open your claim page and read the latest message from our team. It explains what we need. You can reply there and add photos or documents right from your phone or computer.',
      claimLink('Open your claim page:'),
    ),
    sms: 'Home Delivery Claims: We need a bit more information for claim {{claimNumber}}. Please read the message on your claim page and add any documents: {{portalUrl}}',
    portalText:
      "We need a little more information to keep your claim moving. Please read the latest message from our team below, then reply or add the photos or documents we asked for. We'll pick your claim back up as soon as we have them.",
  },
  estimate_in_progress: {
    emailSubject: "Claim {{claimNumber}}: we're preparing your estimate",
    emailBody: email(
      "We're now working out the cost to repair or replace the damaged items on your claim {{claimNumber}}.",
      "This can take a little time, especially if we're waiting on quotes. We'll email you as soon as it's ready.",
      claimLink(),
    ),
    sms: "Home Delivery Claims: We're preparing the estimate for claim {{claimNumber}} and will let you know when it's ready. Details: {{portalUrl}}",
    portalText:
      "We're working out the cost to repair or replace your damaged items. This can take a little time if we're waiting on quotes. We'll email you as soon as it's ready, and there's nothing you need to do in the meantime.",
  },
  settlement_offered: {
    emailSubject: 'Your settlement offer for claim {{claimNumber}} is ready',
    emailBody: email(
      "Good news: we've prepared a settlement offer for your claim {{claimNumber}}.",
      "You'll get a separate email from us shortly with the settlement document. Please review it and, if you agree, sign it electronically. It only takes a few minutes. The document is also linked on your claim page.",
      'If you have any questions about the offer, just reply to this email or send us a message from your claim page before you sign.',
      claimLink(),
    ),
    sms: 'Home Delivery Claims: Your settlement offer for claim {{claimNumber}} is ready. Watch for an email with the document to review and sign. Details: {{portalUrl}}',
    portalText:
      "We've sent you a settlement offer to review and sign electronically. Look for an email from us with the settlement document, or open it from this page. If you have questions about the offer, send us a message below before you sign. Once you've signed, we'll ask how you'd like to be paid.",
  },
  settlement_signed: {
    emailSubject: "Claim {{claimNumber}}: choose how you'd like to be paid",
    emailBody: email(
      "Thank you for signing your settlement for claim {{claimNumber}}. We've received it.",
      "The last step is to choose how you'd like to be paid: by mailed check or by direct deposit (ACH) to your bank account. Please fill in our secure payment form:\n{{paymentFormUrl}}",
      "You'll also find the form on your claim page. For your security, please only enter bank details in that form, and never send them by email or text. We'll send your payment once we have your details.",
      claimLink(),
    ),
    sms: "Home Delivery Claims: Thank you for signing! Please choose how you'd like to be paid for claim {{claimNumber}} (check or direct deposit) on your claim page: {{portalUrl}}",
    portalText:
      "Thank you for signing your settlement. The last step is to tell us how you'd like to be paid, by mailed check or direct deposit (ACH), using the secure payment form linked on this page. Please never send bank details by email or text. We'll send your payment once your details are in.",
  },
  payment_sent: {
    emailSubject: 'Your payment for claim {{claimNumber}} is on its way',
    emailBody: email(
      'Your settlement payment for claim {{claimNumber}} has been sent, using the payment method you chose.',
      'Direct deposits usually arrive within a few business days. Mailed checks can take a little longer.',
      "If your payment hasn't arrived after two weeks, please reply to this email or send us a message from your claim page and we'll look into it.",
      claimLink(),
    ),
    sms: 'Home Delivery Claims: Your payment for claim {{claimNumber}} has been sent. Details: {{portalUrl}}',
    portalText:
      "Your payment has been sent using the method you chose. Direct deposits usually arrive within a few business days; mailed checks can take a little longer. If it hasn't arrived after two weeks, send us a message below and we'll look into it.",
  },
  closed: {
    emailSubject: 'Your claim {{claimNumber}} is now closed',
    emailBody: email(
      'Your claim {{claimNumber}} is now closed. Thank you for your patience while we worked on it. We know a damaged delivery is frustrating, and we appreciate you letting us help.',
      'Your claim page will stay available if you want to look back at messages or documents. If you have a question, you can still reply to this email or send us a message there.',
      claimLink(),
    ),
    sms: 'Home Delivery Claims: Your claim {{claimNumber}} is now closed. Thank you for your patience. Details: {{portalUrl}}',
    portalText:
      'This claim is closed. Thank you for your patience while we worked on it. You can still look back at your messages and documents here, and if you have a question, send us a message below.',
  },
  denied: {
    emailSubject: 'An update on your claim {{claimNumber}}',
    emailBody: email(
      "Thank you for your patience while we reviewed your claim {{claimNumber}}. After a careful review, we weren't able to approve it.",
      "We know this isn't the news you were hoping for. You'll find more detail from our team on your claim page.",
      "If you have questions, or new information or photos you'd like us to consider, please reply to this email or send us a message from your claim page. We'll get back to you.",
      claimLink(),
    ),
    sms: "Home Delivery Claims: There's an update on your claim {{claimNumber}}. Please check your email or your claim page: {{portalUrl}}",
    portalText:
      "We weren't able to approve this claim. We know this isn't the news you were hoping for. If you have questions, or new information or photos you'd like us to consider, send us a message below and we'll get back to you.",
  },
};

const EVENT_DEFAULTS: Record<EventTemplateKey, Omit<MessageTemplate, 'key'>> = {
  confirmation: {
    emailSubject: "We've received your claim ({{claimNumber}})",
    emailBody: CONFIRMATION_BODY,
    sms: CONFIRMATION_SMS,
    portalText: '',
  },
  new_message: {
    emailSubject: 'New message about your claim {{claimNumber}}',
    emailBody: email(
      'You have a new message about claim {{claimNumber}}:',
      '{{message}}',
      'You can reply to this email, or answer on your claim page, where you can also add photos or documents:\n{{portalUrl}}',
      PRIVATE_NOTE,
    ),
    sms: 'Home Delivery Claims: You have a new message about claim {{claimNumber}}. Read and reply here: {{portalUrl}}',
    portalText: '',
  },
  login_code: {
    emailSubject: 'Your sign-in code for claim {{claimNumber}}',
    emailBody: email(
      "Here's your code to open claim {{claimNumber}} on this device:",
      '{{code}}',
      "The code works for 10 minutes. Please don't share it with anyone. Our team will never ask you for it.",
      "If you didn't try to open your claim, you can ignore this email. Your claim stays private.",
      claimLink(),
    ),
    sms: '',
    portalText: '',
  },
  claim_links: {
    emailSubject: 'Your claim links from Home Delivery Claims',
    emailBody: email(
      'You asked us to help you find your claim. Here are the claims we have for this email address:',
      '{{claimList}}',
      "These links are private to you, so please don't forward this email.",
      "If you didn't ask for this, you can safely ignore this email.",
    ),
    sms: '',
    portalText: '',
  },
  status_reply: {
    emailSubject: '',
    emailBody: '',
    sms: 'Home Delivery Claims: Claim {{claimNumber}}: {{statusLabel}}. Details: {{portalUrl}}',
    portalText: '',
  },
};

export const DEFAULT_TEMPLATES: Readonly<Record<TemplateKey, Readonly<MessageTemplate>>> = Object.freeze(
  Object.fromEntries(
    Object.entries({ ...STATUS_DEFAULTS, ...EVENT_DEFAULTS }).map(([key, t]) => [key, Object.freeze({ key, ...t })]),
  ) as Record<TemplateKey, MessageTemplate>,
);

// Used when the board has no label (or it was cleared).
const STATUS_FALLBACK_LABELS: Record<StatusKey, string> = {
  received: 'Received',
  under_review: 'Under review',
  more_info_needed: 'More information needed',
  estimate_in_progress: 'Estimate in progress',
  settlement_offered: 'Settlement offered',
  settlement_signed: 'Settlement signed',
  payment_sent: 'Payment sent',
  closed: 'Closed',
  denied: 'Denied',
};

const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// "October 22, 2026", in the business's time zone.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFormat.format(d);
}

// "$1,250.00"
export function formatMoney(amount: number | null | undefined): string {
  return amount === null || amount === undefined || !Number.isFinite(amount) ? '' : moneyFormat.format(amount);
}

const isTemplateKey = (k: unknown): k is TemplateKey => typeof k === 'string' && (ALL_TEMPLATE_KEYS as readonly string[]).includes(k);
const isStatusKey = (k: TemplateKey): k is StatusKey => (STATUS_KEYS as readonly string[]).includes(k);
const assertKey = (k: unknown): TemplateKey => {
  if (!isTemplateKey(k)) throw new Error(`Unknown template key: ${String(k)}`);
  return k;
};

const LIMITS = { emailSubject: 200, emailBody: 20_000, sms: 1_000, portalText: 5_000 } as const;
const normalize = (s: unknown): string => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n') : '');

export function createTemplateService(ctx: CoreContext, services: Services): TemplateService {
  const getDefault = (key: TemplateKey): MessageTemplate => ({ ...DEFAULT_TEMPLATES[assertKey(key)] });

  return {
    getDefault,

    get: (key) => ctx.repo.getTemplateOverride(assertKey(key)) ?? getDefault(key),

    save(t, updatedBy) {
      const key = assertKey(t.key);
      const clean: MessageTemplate = {
        key,
        emailSubject: normalize(t.emailSubject).replace(/\s+/g, ' ').trim(),
        emailBody: normalize(t.emailBody).trim(),
        sms: EMAIL_ONLY_TEMPLATE_KEYS.has(key) ? '' : normalize(t.sms).trim(),
        portalText: isStatusKey(key) ? normalize(t.portalText).trim() : '',
      };
      for (const [field, max] of Object.entries(LIMITS) as Array<[keyof typeof LIMITS, number]>) {
        if (clean[field].length > max) throw new Error(`Template ${key}: ${field} is longer than ${max} characters`);
      }
      ctx.repo.saveTemplate(clean, updatedBy);
    },

    reset: (key) => ctx.repo.deleteTemplateOverride(assertKey(key)),

    vars(claim: Claim, extra: Partial<TemplateVars> = {}): TemplateVars {
      let paymentFormUrl = '';
      try {
        paymentFormUrl = services.payment.paymentFormUrl(claim);
      } catch {
        // Payment form unavailable: the template line renders empty and the claim page still links it.
      }
      const vars: TemplateVars = {
        firstName: claim.firstName.trim() || 'there',
        claimantName: claim.claimantName.trim(),
        claimNumber: claim.claimNumber,
        portalUrl: services.tokens.portalUrl(claim),
        statusLabel: claim.statusLabel?.trim() || (claim.statusKey ? STATUS_FALLBACK_LABELS[claim.statusKey] : ''),
        dateReceived: formatDate(claim.receivedAt),
        amountClaimed: formatMoney(claim.amountClaimed),
        settlementAmount: formatMoney(claim.settlementAmount),
        paymentFormUrl,
        message: '',
        code: '',
        claimList: '',
      };
      for (const [k, v] of Object.entries(extra) as Array<[keyof TemplateVars, unknown]>) {
        if (v !== undefined && v !== null && TEMPLATE_VAR_NAMES.includes(k)) vars[k] = String(v);
      }
      return vars;
    },

    // Single pass, so a value that itself contains "{{...}}" (a claimant's
    // message, say) is never expanded.
    render(text, vars) {
      const values = vars as unknown as Record<string, unknown>;
      return text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, name: string) => {
        const v = Object.hasOwn(values, name) ? values[name] : undefined;
        return v === undefined || v === null ? '' : String(v);
      });
    },
  };
}
