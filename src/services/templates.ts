// STUB — replaced during implementation.
import type { CoreContext, TemplateService, Services } from './contracts.js';

export function createTemplateService(_ctx: CoreContext, _services: Services): TemplateService {
  return new Proxy({} as TemplateService, {
    get: (_t, prop) => () => {
      throw new Error(`TemplateService.${String(prop)} not implemented`);
    },
  });
}
