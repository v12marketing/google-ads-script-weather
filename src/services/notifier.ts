// STUB — replaced during implementation.
import type { CoreContext, Notifier, Services } from './contracts.js';

export function createNotifier(_ctx: CoreContext, _services: Services): Notifier {
  return new Proxy({} as Notifier, {
    get: (_t, prop) => () => {
      throw new Error(`Notifier.${String(prop)} not implemented`);
    },
  });
}
