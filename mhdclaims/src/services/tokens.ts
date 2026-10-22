import { createHash, createHmac } from 'node:crypto';
import type { CoreContext, TokenService } from './contracts.js';

export function createTokenService(ctx: CoreContext): TokenService {
  const portalToken = (itemId: string, tokenVersion: number): string =>
    createHmac('sha256', ctx.config.APP_SECRET).update(`portal:${itemId}:${tokenVersion}`).digest('base64url');

  const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

  return {
    portalToken,
    tokenHash,
    portalUrl: (claim) => `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/c/${portalToken(claim.itemId, claim.tokenVersion)}`,
    claimForToken(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const claim = ctx.repo.getClaimByTokenHash(tokenHash(token));
      if (!claim) return null;
      // A rotated link stays dead even though its hash lookup can't match anymore.
      return portalToken(claim.itemId, claim.tokenVersion) === token ? claim : null;
    },
  };
}
