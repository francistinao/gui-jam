import type { UpdateResult } from '@gui-jam/contracts-ts';

export interface UpdateStart {
  updateId: string;
  urls: readonly string[];
  /** One `update` (or `full-reload`) payload follows per reloaded module. */
  expectedUpdates: number;
}

declare module 'vite/types/customEvent.d.ts' {
  interface CustomEventMap {
    'gj:update-start': UpdateStart;
    'gj:update-result': UpdateResult;
  }
}
