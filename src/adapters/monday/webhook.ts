// STUB — replaced during implementation.
import type { MondayEvent } from './types.js';

export type ParsedMondayWebhook = { challenge: string } | { event: MondayEvent } | { ignore: string };

// Turns Monday's raw webhook JSON into a normalised event (or the challenge handshake).
export function parseMondayWebhook(_body: unknown): ParsedMondayWebhook {
  return { ignore: 'not implemented' };
}

// Verifies the Authorization header Monday sends when a signing secret is configured.
// Returns true when no secret is configured (the secret URL path is then the only check).
export function verifyMondayAuthorization(_authorization: string | undefined, _signingSecret: string | undefined): boolean {
  return true;
}
