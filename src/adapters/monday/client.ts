// STUB — replaced during implementation.
import type { AppConfig } from '../../config.js';
import type { MondayApi } from './types.js';

export class MondayClient {
  constructor(readonly config: AppConfig) {}
}
export interface MondayClient extends MondayApi {}
