import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { GJD_BINARY, requireDaemonBinary, stopDaemon } from '../e2e/support/daemon.js';

const PLAYGROUND =
  process.env.GUIJAM_PLAYGROUND ?? join(homedir(), 'Documents/personal/guijam-playground');
const NODE24 =
  process.env.GUIJAM_NODE24_BIN ??
  readdirSync(join(homedir(), '.nvm/versions/node'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('v24.'))
    .map((entry) => join(homedir(), '.nvm/versions/node', entry.name, 'bin'))
    .at(-1);
const BLUE_RGB = 'rgb(29, 78, 216)';
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.react-router',
  '.guijam',
  '.vinxi',
  '.nitro',
  'dist',
  'build',
]);
const TARGETS = ['h1', 'h2', 'p', 'a', 'button', 'main', 'div'];
const AGENT_MARKERS = /^(?:CLAUDE|AI_AGENT|CODEX|CURSOR_AGENT|GEMINI_CLI|OPENCODE)/;

function humanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !AGENT_MARKERS.test(name) && name !== 'GUIJAM_GJD_BIN',
    ),
  );
}

interface App {
  name: string;
  port: number;
  node24?: boolean;
}

const APPS: readonly App[] = [
  { name: 'sveltekit', port: 4401 },
  { name: 'solid', port: 4402 },
  { name: 'nuxt', port: 4403 },
  { name: 'astro', port: 4404 },
  { name: 'react-router', port: 4405 },
  { name: 'next', port: 4406 },
  { name: 'solidstart', port: 4407, node24: true },
];

function sourceHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(path).update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function stopGroup(child: ChildProcess | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.pid === undefined) {
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

async function waitForHttp(url: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the dev server exited:\n${output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the dev server never answered:\n${output()}`);
}

async function target(page: Page): Promise<Locator> {
  for (const tag of TARGETS) {
    const candidates = page.locator(`${tag}[data-gj-src]`);
    for (let index = 0; index < Math.min(await candidates.count(), 10); index += 1) {
      const candidate = candidates.nth(index);
      const leaf = await candidate.evaluate((node) => !node.querySelector('[data-gj-src]'));
      const box = await candidate.boundingBox();
      if (leaf && box && box.width > 8 && box.height > 8 && box.y < 600) return candidate;
    }
  }
  throw new Error('no visible element maps to source');
}

async function selectTool(page: Page): Promise<void> {
  const tool = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

async function setFill(panel: Locator, hex: string): Promise<void> {
  const fill = panel.getByRole('region', { name: 'Fill' });
  const add = fill.getByRole('button', { name: 'Add fill' });
  if (await add.isVisible()) await add.click();
  await fill.getByRole('textbox', { name: 'Fill hex' }).fill(hex);
}

async function openFinetune(page: Page, element: Locator): Promise<Locator> {
  await element.click();
  const panel = page.getByRole('dialog', { name: /^Fine-tune / });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
}

for (const app of APPS) {
  test.describe(app.name, () => {
    const dir = join(PLAYGROUND, 'apps', app.name);
    const url = `http://localhost:${app.port}/`;
    let child: ChildProcess | undefined;
    let output = '';

    test.skip(!existsSync(dir), `run scripts/playground.sh to create ${dir}`);
    test.skip(app.node24 === true && NODE24 === undefined, 'needs Node 24');

    const start = () => {
      const path = app.node24 ? `${NODE24}:${process.env.PATH ?? ''}` : process.env.PATH;
      output = '';
      child = spawn('pnpm', ['dev', '--port', String(app.port)], {
        cwd: dir,
        env: {
          ...humanEnvironment(),
          PATH: path,
          ...(process.env.GUIJAM_PACKAGED_GJD === '1' ? {} : { GUIJAM_GJD_BIN: GJD_BINARY }),
          NEXT_TELEMETRY_DISABLED: '1',
          NUXT_TELEMETRY_DISABLED: '1',
          ASTRO_TELEMETRY_DISABLED: '1',
          ASTRO_DISABLE_UPDATE_CHECK: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      return child;
    };

    test.beforeAll(async () => {
      await requireDaemonBinary();
      await stopDaemon(dir);
      await waitForHttp(url, start(), () => output);
    });

    test.afterAll(async () => {
      await stopGroup(child);
      await stopDaemon(dir);
    });

    test('the toolbar boots and elements map to source', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url);

      await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-gj-src]').first()).toBeAttached();
      expect(errors).toEqual([]);
    });

    test('fine-tune previews a fill, Close restores it, Apply and Undo leave the files as they were', async ({
      page,
    }) => {
      const before = sourceHash(dir);
      await page.goto(url);
      await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toBeVisible({ timeout: 60_000 });
      const element = await target(page);
      const src = await element.getAttribute('data-gj-src');
      const located = page.locator(`[data-gj-src="${src}"]`).first();
      const original = await located.evaluate((node) => getComputedStyle(node).backgroundColor);
      await selectTool(page);

      let panel = await openFinetune(page, located);
      await setFill(panel, '1d4ed8');
      await expect(located).toHaveCSS('background-color', BLUE_RGB);
      expect(sourceHash(dir)).toBe(before);
      await panel.getByRole('button', { name: 'Close' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Unsaved tweaks were reverted.' }),
      ).toBeVisible();
      await expect(located).toHaveCSS('background-color', original);
      expect(sourceHash(dir)).toBe(before);

      panel = await openFinetune(page, page.locator(`[data-gj-src="${src}"]`).first());
      await setFill(panel, '1d4ed8');
      await expect(page.locator(`[data-gj-src="${src}"]`).first()).toHaveCSS(
        'background-color',
        BLUE_RGB,
      );
      await panel.getByRole('button', { name: 'Apply' }).click();
      const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
      await expect(toast).toBeVisible();
      expect(sourceHash(dir)).not.toBe(before);
      await toast.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(() => sourceHash(dir), { timeout: 20_000 }).toBe(before);
    });
  });
}
