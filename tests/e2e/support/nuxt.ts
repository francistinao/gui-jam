import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { binOf, IS_WINDOWS, mergeEnv, stopTree } from './process.js';

const READY = /Ready in/;
const START_TIMEOUT_MS = 90_000;

export interface NuxtServer {
  url: string;
  output: () => string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

export async function startNuxt(dir: string, env: NodeJS.ProcessEnv): Promise<NuxtServer> {
  const port = await freePort();
  const child = spawn(binOf(dir, 'nuxt'), ['dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: dir,
    env: mergeEnv(process.env, { ...env, NUXT_TELEMETRY_DISABLED: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WINDOWS,
    shell: IS_WINDOWS,
  });
  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`nuxt dev did not get ready:\n${output}`)),
      START_TIMEOUT_MS,
    );
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (READY.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`nuxt dev exited with ${code}:\n${output}`));
    });
  });
  try {
    await ready;
  } catch (error) {
    await stopTree(child);
    throw error;
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    output: () => output,
    stop: () => stopTree(child),
  };
}
