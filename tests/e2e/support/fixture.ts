import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import type { GuijamApi } from 'guijam/vite';
import type * as Vite from 'vite';

export const FIXTURE_DIR = fileURLToPath(
  new URL('../../../fixtures/small-react-tailwind4/', import.meta.url),
);

export function fixturePath(relativePath: string): string {
  return join(FIXTURE_DIR, relativePath);
}

export interface FixtureServer {
  vite: typeof Vite;
  server: Vite.ViteDevServer;
  api: GuijamApi;
  url: string;
}

// The matrix run swaps the fixture's Vite version, so drive the Vite that the
// fixture itself resolves rather than one hoisted to the repo root.
async function loadFixtureVite(): Promise<typeof Vite> {
  const vitePackageJson = createRequire(join(FIXTURE_DIR, 'package.json')).resolve(
    'vite/package.json',
  );
  return import(pathToFileURL(join(dirname(vitePackageJson), 'dist/node/index.js')).href);
}

/** `configFile` is relative to the fixture; the default is its `vite.config.ts`. */
export async function startFixtureServer(configFile?: string): Promise<FixtureServer> {
  const vite = await loadFixtureVite();
  const server = await vite.createServer({
    root: FIXTURE_DIR,
    logLevel: 'warn',
    ...(configFile === undefined ? {} : { configFile: fixturePath(configFile) }),
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Vite did not report a local URL');
  const plugin = server.config.plugins.find(({ name }) => name === 'guijam');
  if (!plugin?.api) throw new Error('guijam is not registered in the fixture vite.config.ts');
  return { vite, server, api: plugin.api, url };
}

export async function openFixture(page: Page, url: string): Promise<void> {
  const connected = page.waitForEvent('console', (msg) => msg.text().includes('[vite] connected'));
  await page.goto(url);
  await connected;
}

export async function fileSnapshot(path: string) {
  const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  return { content, mtimeMs: stats.mtimeMs };
}

export function replaceOnce(source: string, find: string, replacement: string): string {
  if (!source.includes(find)) throw new Error(`fixture no longer contains "${find}"`);
  return source.replace(find, replacement);
}
