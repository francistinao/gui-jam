import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

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

function stopGroup(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      resolve();
    }
    setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        resolve();
      }
    }, 5_000).unref();
  });
}

export async function startNuxt(dir: string, env: NodeJS.ProcessEnv): Promise<NuxtServer> {
  const port = await freePort();
  const child = spawn(
    join(dir, 'node_modules/.bin/nuxt'),
    ['dev', '--port', String(port), '--host', '127.0.0.1'],
    {
      cwd: dir,
      env: { ...process.env, ...env, NUXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
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
    await stopGroup(child);
    throw error;
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    output: () => output,
    stop: () => stopGroup(child),
  };
}
