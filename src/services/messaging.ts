import { createHash } from 'node:crypto';
import type { HighLevelEvent } from '../adapters/highlevel/types.js';
import type { MondayEvent } from '../adapters/monday/types.js';
import type { Claim, ClaimMessage, MessageChannel } from '../domain/types.js';
import { textToHtml } from '../web/html.js';
import { onceFor } from './claim-fields.js';
import { JOB, type CoreContext, type MessagingService, type Services } from './contracts.js';
import { stripEmailReply } from './email-reply.js';
import { ClaimantInputError } from './errors.js';
import { PermanentJobError } from './jobs.js';

export { ClaimantInputError } from './errors.js';

// Two-way messages between the team (Monday updates) and the claimant (portal,
// email and SMS replies). Message bodies are never logged.

export const MAX_MESSAGE_CHARS = 5000;

// Carrier opt-out / opt-in keywords that HighLevel acts on (SMS only).
const OPT_OUT_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP', 'YES']);

const CHANNEL_LABEL: Record<MessageChannel, string> = { portal: 'claim page', sms: 'text', email: 'email', monday: 'Monday' };

const OPT_OUT_UPDATE = '<p>Claimant opted out of text messages; updates will go by email.</p>';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text after the claimant-message prefix, or null when the update is internal.
// Case-insensitive, tolerant of extra whitespace inside and after the prefix.
export function claimantMessageBody(text: string, prefix: string): string | null {
  const p = prefix.trim();
  if (!p) return null;
  const pattern = p.split(/\s+/).map(escapeRegExp).join('\\s+');
  // A prefix ending in a letter must end at a word boundary ("To claimant" ≠ "To claimants").
  const boundary = /\w$/.test(p) ? '(?!\\w)' : '';
  const t = text.trim();
  const m = new RegExp(`^${pattern}${boundary}`, 'i').exec(t);
  if (!m) return null;
  return t.slice(m[0].length).trim() || null;
}

// Normalises line endings and drops control characters other than tab/newline.
export const cleanMessageText = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();

// Whole-message SMS keyword: "stop", " Stop. " and "STOP!" all count.
const keywordOf = (body: string): string => body.trim().replace(/[.!?]+$/, '').trim().toUpperCase();

const isOpen = (c: Claim): boolean => c.statusKey !== 'closed' && c.statusKey !== 'denied';

// HTML for the Monday update that carries a claimant's message.
export function claimantUpdateHtml(m: Pick<ClaimMessage, 'channel' | 'body'>): string {
  return `<p><strong>From claimant (${CHANNEL_LABEL[m.channel]}):</strong></p>\n${textToHtml(m.body).value}`;
}

// In-app notification to each configured team member, once per user per key, so
// a retried job only notifies the ones that failed.
export async function notifyTeam(ctx: CoreContext, claim: Claim, keyBase: string, text: string): Promise<void> {
  for (const userId of ctx.board.notifyUserIds) {
    await onceFor(ctx, `${keyBase}:notify:${userId}`, () => ctx.monday.notifyUser(userId, claim.itemId, text));
  }
}

export function createMessagingService(ctx: CoreContext, services: Services): MessagingService {
  const { board, config, db, repo, jobs, monday, log } = ctx;

  // Stores a claimant message and queues its Monday post in one transaction.
  // Null when the HighLevel message id was already recorded.
  function recordFromClaimant(claim: Claim, channel: MessageChannel, body: string, highlevelMessageId: string | null): ClaimMessage | null {
    return db.transaction(() => {
      const m = repo.addMessage({ itemId: claim.itemId, direction: 'from_claimant', channel, body, highlevelMessageId });
      if (m) jobs.enqueue(JOB.portalMessageToMonday, { messageId: m.id }, { dedupeKey: `claimant-msg:${m.id}` });
      return m;
    })();
  }

  // Sends a team message to the claimant. Safe to repeat: the notifier skips
  // channels already sent for this event key.
  async function sendToClaimant(claim: Claim, m: ClaimMessage): Promise<void> {
    const doneKey = `msg:${m.mondayUpdateId}:done`;
    if (repo.isEventProcessed(doneKey)) return;
    const res = await services.notifier.notify(claim, 'new_message', { message: m.body }, { eventKey: `msg:${m.mondayUpdateId}` });
    if (!res.emailSent && !res.smsSent) log.warn({ itemId: claim.itemId, messageId: m.id }, 'team message stored but the claimant has no email or SMS');
    repo.markEventProcessed(doneKey);
  }

  async function handleMondayUpdate(event: Extract<MondayEvent, { kind: 'update_created' }>): Promise<void> {
    const { itemId, updateId } = event;
    const claim = repo.getClaim(itemId);
    if (!claim) {
      log.info({ itemId, updateId }, 'messaging: update on an item that is not a claim, ignoring');
      return;
    }

    const prior = repo.getMessageByMondayUpdateId(updateId);
    if (prior) {
      // Either our own post of a claimant message, or a redelivery / retry of a
      // team message already stored (finish sending it).
      if (prior.itemId === itemId && prior.direction === 'to_claimant') await sendToClaimant(claim, prior);
      return;
    }

    let { textBody, creatorId } = event;
    if (!textBody.trim() || !creatorId) {
      const u = await monday.getUpdate(updateId);
      if (!u || (u.itemId && u.itemId !== itemId)) {
        log.warn({ itemId, updateId }, 'messaging: update not found on the item, ignoring');
        return;
      }
      textBody = u.textBody || textBody;
      creatorId = u.creatorId ?? creatorId;
    }
    // Our own posts (claimant messages, notes) must never echo back to the claimant.
    if (!creatorId || creatorId === config.MONDAY_INTEGRATION_USER_ID) return;

    const body = claimantMessageBody(cleanMessageText(textBody), board.claimantMessagePrefix);
    if (!body) return; // internal note: never sent, never stored

    const m = repo.addMessage({ itemId, direction: 'to_claimant', channel: 'monday', body, mondayUpdateId: updateId });
    if (!m) return;
    log.info({ itemId, updateId, messageId: m.id }, 'messaging: team message for the claimant');
    await sendToClaimant(claim, m);
  }

  function postFromPortal(claim: Claim, text: string): ClaimMessage {
    const body = typeof text === 'string' ? cleanMessageText(text) : '';
    if (!body) throw new ClaimantInputError('Please write a message before sending.', 'empty_message');
    if (body.length > MAX_MESSAGE_CHARS) {
      throw new ClaimantInputError(
        `Your message is too long. Please keep it under ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters, or send it in two parts.`,
        'message_too_long',
      );
    }
    const m = recordFromClaimant(claim, 'portal', body, null);
    if (!m) throw new Error('Claimant message was not stored');
    log.info({ itemId: claim.itemId, messageId: m.id }, 'messaging: claimant wrote on the claim page');
    return m;
  }

  async function deliverPortalMessage(messageId: number): Promise<void> {
    const m = repo.getMessage(messageId);
    if (!m || m.direction !== 'from_claimant') {
      log.warn({ messageId }, 'messaging: no claimant message to deliver');
      return;
    }
    const claim = repo.getClaim(m.itemId);
    if (!claim) throw new PermanentJobError(`No claim for message ${messageId}`);
    if (!m.mondayUpdateId) {
      // Posted as the integration user, so the update_created webhook is ignored.
      const updateId = await monday.createUpdate(m.itemId, claimantUpdateHtml(m));
      repo.setMessageMondayUpdateId(m.id, updateId);
      log.info({ itemId: m.itemId, messageId, updateId }, 'messaging: claimant message posted to Monday');
    }
    await notifyTeam(ctx, claim, `claimant-msg:${m.id}`, `${claim.claimNumber}: new message from the claimant`);
  }

  async function replyWithStatus(claim: Claim, messageId: string | null): Promise<void> {
    const send = async () => {
      const t = services.templates.get('status_reply');
      // Amounts and payment links never go by SMS.
      const vars = { ...services.templates.vars(claim), amountClaimed: '', settlementAmount: '', paymentFormUrl: '' };
      const sent = await services.notifier.sendSms(claim, services.templates.render(t.sms, vars));
      log.info({ itemId: claim.itemId, sent }, 'messaging: STATUS keyword reply');
    };
    if (messageId) await onceFor(ctx, `inbound:${messageId}:status`, send);
    else await send();
  }

  // STOP applies to the HighLevel contact, so to every claim it is linked to.
  // The team hears about each claim that changed; the "changed" marker is written
  // with the flag so a retry after a failed Monday post still posts it.
  async function setSmsOptOut(claims: Claim[], optedOut: boolean, eventId: string): Promise<void> {
    const changedKey = (itemId: string) => `sms-optout:${eventId}:${itemId}`;
    db.transaction(() => {
      for (const c of claims) {
        if (c.smsOptedOut === optedOut) continue;
        repo.updateClaim(c.itemId, { smsOptedOut: optedOut });
        if (optedOut) repo.markEventProcessed(changedKey(c.itemId));
      }
    })();
    log.info({ itemIds: claims.map((c) => c.itemId), optedOut }, 'messaging: SMS opt-out updated');
    if (!optedOut) return;
    for (const c of claims) {
      if (!repo.isEventProcessed(changedKey(c.itemId))) continue;
      await onceFor(ctx, `${changedKey(c.itemId)}:posted`, () => monday.createUpdate(c.itemId, OPT_OUT_UPDATE));
    }
  }

  async function handleInbound(event: Extract<HighLevelEvent, { kind: 'inbound_message' }>): Promise<void> {
    const claims = repo.findClaimsByContact(event.contactId);
    const claim = claims.find(isOpen) ?? claims[0];
    if (!claim) {
      log.info({ contactId: event.contactId, channel: event.channel }, 'messaging: inbound message from a contact with no claim');
      return;
    }

    if (event.channel === 'sms') {
      const kw = keywordOf(event.body);
      const eventId = event.messageId ?? createHash('sha256').update(`${event.contactId}\n${event.body}`).digest('hex').slice(0, 32);
      if (kw === 'STATUS') return replyWithStatus(claim, event.messageId);
      if (kw === 'HELP') return; // HighLevel / the carrier answer HELP
      if (OPT_OUT_KEYWORDS.has(kw)) return setSmsOptOut(claims, true, eventId);
      // "Yes" is usually an answer to the team, unless the contact is opted out.
      if (OPT_IN_KEYWORDS.has(kw) && (kw !== 'YES' || claims.some((c) => c.smsOptedOut))) {
        return setSmsOptOut(claims, false, eventId);
      }
    }

    const body = cleanMessageText(event.channel === 'email' ? stripEmailReply(event.body) : event.body);
    if (!body) return;
    const m = recordFromClaimant(claim, event.channel, body, event.messageId);
    if (!m) {
      log.info({ itemId: claim.itemId }, 'messaging: inbound message already recorded');
      return;
    }
    log.info({ itemId: claim.itemId, messageId: m.id, channel: event.channel }, 'messaging: claimant replied');
  }

  return { handleMondayUpdate, postFromPortal, deliverPortalMessage, handleInbound };
}
