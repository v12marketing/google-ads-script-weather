// STUB — replaced during implementation.
import type { CoreContext, StatusService, Services } from './contracts.js';

export function createStatusService(_ctx: CoreContext, _services: Services): StatusService {
  return new Proxy({} as StatusService, {
    get: (_t, prop) => () => {
      throw new Error(`StatusService.${String(prop)} not implemented`);
    },
  });
}
