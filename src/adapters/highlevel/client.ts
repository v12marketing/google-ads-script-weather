// STUB — replaced during implementation.
import type { AppConfig } from '../../config.js';
import type { HighLevelApi } from './types.js';

export class HighLevelClient {
  constructor(readonly config: AppConfig) {}
}
export interface HighLevelClient extends HighLevelApi {}
