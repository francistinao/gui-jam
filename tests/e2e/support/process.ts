import { type ChildProcess, execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

export function searchPath(...entries: (string | undefined)[]): string {
  return entries.filter((entry): entry is string => Boolean(entry)).join(delimiter);
}

export function mergeEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const replaced = new Set(Object.keys(extra).map((key) => key.toUpperCase()));
  const kept = Object.entries(base).filter(([key]) => !replaced.has(key.toUpperCase()));
  return { ...Object.fromEntries(kept), ...extra };
}

export function withSearchPath(env: NodeJS.ProcessEnv, ...dirs: string[]): NodeJS.ProcessEnv {
  const current = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  return mergeEnv(env, { PATH: searchPath(...dirs, current) });
}

export function binOf(dir: string, name: string): string {
  const bin = join(dir, 'node_modules', '.bin', IS_WINDOWS ? `${name}.cmd` : name);
  return IS_WINDOWS ? `"${bin}"` : bin;
}

export function stopTree(child: ChildProcess, graceMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (child.exitCode !== null || pid === undefined) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    if (IS_WINDOWS) {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      resolve();
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        resolve();
      }
    }, graceMs).unref();
  });
}
