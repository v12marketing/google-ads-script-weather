// STUB — replaced during implementation.
import type { CoreContext, PaymentService, Services } from './contracts.js';

export function createPaymentService(_ctx: CoreContext, _services: Services): PaymentService {
  return new Proxy({} as PaymentService, {
    get: (_t, prop) => () => {
      throw new Error(`PaymentService.${String(prop)} not implemented`);
    },
  });
}
