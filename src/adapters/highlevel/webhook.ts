// STUB — replaced during implementation.
import type { HighLevelEvent } from './types.js';

// Turns a HighLevel webhook body into a normalised event; null for events we ignore.
export function parseHighLevelWebhook(_body: unknown): HighLevelEvent | null {
  return null;
}

// Verifies HighLevel's Ed25519 x-ghl-signature over the raw body.
export function verifyHighLevelSignature(_rawBody: string, _signature: string | undefined, _publicKey: string): boolean {
  return false;
}
