import type { GuijamMessage, UpdateResult } from '@guijam/contracts-ts';

export interface UpdateStart {
  updateId: string;
  urls: readonly string[];
  expectedUpdates: number;
}

declare module 'vite/types/customEvent.d.ts' {
  interface CustomEventMap {
    'gj:update-start': UpdateStart;
    'gj:update-result': UpdateResult;
    'gj:request': unknown;
    'gj:response': GuijamMessage;
    'gj:event': GuijamMessage;
    'gj:reloading': Record<string, never>;
  }
}
