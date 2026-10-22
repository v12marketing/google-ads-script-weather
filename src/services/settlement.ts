// STUB — replaced during implementation.
import type { CoreContext, SettlementService, Services } from './contracts.js';

export function createSettlementService(_ctx: CoreContext, _services: Services): SettlementService {
  return new Proxy({} as SettlementService, {
    get: (_t, prop) => () => {
      throw new Error(`SettlementService.${String(prop)} not implemented`);
    },
  });
}
