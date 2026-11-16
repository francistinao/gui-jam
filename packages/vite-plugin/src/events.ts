import type { GuijamMessage, UpdateResult } from '@guijam/contracts-ts';

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
    /** A widget request; untrusted until `checkWidgetRequest` admits it. */
    'gj:request': unknown;
    'gj:response': GuijamMessage;
    /** Pushed by the daemon to the page a run belongs to, e.g. `generate.progress`. */
    'gj:event': GuijamMessage;
  }
}
