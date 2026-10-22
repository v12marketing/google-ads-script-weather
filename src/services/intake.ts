// STUB — replaced during implementation.
import type { CoreContext, IntakeService, Services } from './contracts.js';

export function createIntakeService(_ctx: CoreContext, _services: Services): IntakeService {
  return new Proxy({} as IntakeService, {
    get: (_t, prop) => () => {
      throw new Error(`IntakeService.${String(prop)} not implemented`);
    },
  });
}
