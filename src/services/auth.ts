// STUB — replaced during implementation.
import type { CoreContext, AuthService, Services } from './contracts.js';

export function createAuthService(_ctx: CoreContext, _services: Services): AuthService {
  return new Proxy({} as AuthService, {
    get: (_t, prop) => () => {
      throw new Error(`AuthService.${String(prop)} not implemented`);
    },
  });
}
