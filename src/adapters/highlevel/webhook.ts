// STUB — replaced during implementation.
import type { HighLevelEvent } from './types.js';

// Turns a HighLevel webhook body into a normalised event; null for events we ignore.
export function parseHighLevelWebhook(_body: unknown): HighLevelEvent | null {
  return null;
}

// Verifies HighLevel's x-wh-signature over the raw body, when present.
export function verifyHighLevelSignature(_rawBody: string, _signature: string | undefined): boolean {
  return true;
}
