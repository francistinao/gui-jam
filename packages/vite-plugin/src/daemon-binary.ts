import { createRequire } from 'node:module';

const BUNDLED_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function bundledDaemon(): string | undefined {
  const platform = platformKey();
  if (!BUNDLED_PLATFORMS.has(platform)) return undefined;
  try {
    return createRequire(import.meta.url).resolve(`@guijam/gjd-${platform}/bin/gjd`);
  } catch {
    return undefined;
  }
}

export function findDaemonBinary(explicit?: string): string | undefined {
  return explicit ?? process.env.GUIJAM_GJD_BIN ?? bundledDaemon();
}
