// STUB — replaced during implementation.
import type { CoreContext, MessagingService, Services } from './contracts.js';

export function createMessagingService(_ctx: CoreContext, _services: Services): MessagingService {
  return new Proxy({} as MessagingService, {
    get: (_t, prop) => () => {
      throw new Error(`MessagingService.${String(prop)} not implemented`);
    },
  });
}
