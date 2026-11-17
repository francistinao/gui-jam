import { createRequire } from 'node:module';

const BUNDLED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
]);

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function bundledDaemon(): string | undefined {
  const platform = platformKey();
  if (!BUNDLED_PLATFORMS.has(platform)) return undefined;
  try {
    const binary = process.platform === 'win32' ? 'gjd.exe' : 'gjd';
    return createRequire(import.meta.url).resolve(`@guijam/gjd-${platform}/bin/${binary}`);
  } catch {
    return undefined;
  }
}

export function findDaemonBinary(explicit?: string): string | undefined {
  return explicit ?? process.env.GUIJAM_GJD_BIN ?? bundledDaemon();
}
