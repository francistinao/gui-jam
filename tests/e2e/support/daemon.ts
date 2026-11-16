import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { GuijamMessage } from '../../../packages/contracts-ts/src/generated/contracts.js';
import type { GuijamApi } from '../../../packages/vite-plugin/dist/index.js';

const run = promisify(execFile);

export const GJD_BINARY = fileURLToPath(new URL('../../../target/debug/gjd', import.meta.url));

export async function requireDaemonBinary(): Promise<void> {
  try {
    await access(GJD_BINARY);
  } catch {
    throw new Error(`${GJD_BINARY} is missing: run \`cargo build -p gjd-daemon\` first`);
  }
}

export async function stopDaemon(projectDir: string): Promise<void> {
  await run(GJD_BINARY, ['daemon', 'stop', '--project', projectDir]);
}

/** Sends widget requests the way the browser widget does, with fresh ids. */
export function widgetRequests(api: GuijamApi) {
  let next = 1;
  return (type: string, payload: object): Promise<GuijamMessage> =>
    api.request({ type, id: `e2e-${next++}`, payload });
}

/** Retries until the plugin has started or reached the daemon. */
export async function waitForDaemon(
  send: ReturnType<typeof widgetRequests>,
  probe: object,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = await send('element.inspect', probe);
    const unavailable = reply.type === 'error' && reply.payload.code === 'DAEMON_UNAVAILABLE';
    if (!unavailable) return;
    if (Date.now() > deadline) throw new Error(`daemon never connected: ${reply.payload.message}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
