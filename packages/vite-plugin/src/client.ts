import type { UpdateError, UpdateResult } from '@guijam/contracts-ts';
import type { ErrorPayload } from 'vite';
import type { UpdateStart } from './events.js';
import { bootToolbar } from './toolbar.js';

interface PendingUpdate extends UpdateStart {
  startedAt: number;
  remaining: number;
}

function toUpdateError(err: ErrorPayload['err'], urls: readonly string[]): UpdateError {
  const file = err.loc?.file ?? err.id;
  const slashed =
    file === undefined ? undefined : `/${file.replaceAll('\\', '/').replace(/^\/+/, '')}`;
  const error: UpdateError = {
    message: err.message,
    attributed:
      slashed !== undefined &&
      urls.some((url) => slashed.endsWith((url.split('?')[0] ?? url).replace(/^\/@fs(?=\/)/, ''))),
  };
  if (file !== undefined) error.file = file;
  if (err.loc?.line !== undefined) error.line = err.loc.line;
  if (err.stack) error.stack = err.stack;
  return error;
}

const BOOTED: unique symbol = Symbol.for('guijam.client.booted');
const scope = globalThis as typeof globalThis & { [BOOTED]?: true };
const hot = scope[BOOTED] ? undefined : import.meta.hot;

if (hot) {
  scope[BOOTED] = true;
  let pending: PendingUpdate | null = null;

  const report = (status: UpdateResult['status'], errors: UpdateError[]) => {
    if (!pending) return;
    const result: UpdateResult = {
      updateId: pending.updateId,
      status,
      latencyMs: performance.now() - pending.startedAt,
      errors,
    };
    pending = null;
    hot.send('gj:update-result', result);
  };

  hot.on('gj:update-start', (data) => {
    pending = { ...data, startedAt: performance.now(), remaining: data.expectedUpdates };
  });

  hot.on('vite:afterUpdate', () => {
    if (!pending) return;
    pending.remaining -= 1;
    if (pending.remaining <= 0) report('ok', []);
  });

  hot.on('vite:error', ({ err }) => {
    if (pending) report('compile_error', [toUpdateError(err, pending.urls)]);
  });

  hot.on('vite:beforeFullReload', () => report('full_reload', []));

  const boot = () => bootToolbar(hot);
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
}
