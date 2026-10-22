// STUB — replaced during implementation.
import type { CoreContext, FileService, Services } from './contracts.js';

export function createFileService(_ctx: CoreContext, _services: Services): FileService {
  return new Proxy({} as FileService, {
    get: (_t, prop) => () => {
      throw new Error(`FileService.${String(prop)} not implemented`);
    },
  });
}
