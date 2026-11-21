import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { GJD_BINARY, requireDaemonBinary, stopDaemon } from './support/daemon.js';
import { openFixture } from './support/fixture.js';
import {
  editFoundText,
  editText,
  pickThemeColor,
  promptForTwo,
  sketchWithUndo,
} from './support/new-features.js';
import { type NuxtServer, startNuxt } from './support/nuxt.js';
import { searchPath } from './support/process.js';

const NUXT_DIR = fileURLToPath(new URL('../../fixtures/small-nuxt-tailwind4/', import.meta.url));
const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const EXTRAS = join(NUXT_DIR, 'app/components/Extras.vue');
const ORDER_BUTTON = join(NUXT_DIR, 'app/components/OrderButton.vue');
const APP = join(NUXT_DIR, 'app/app.vue');
const BLUE_RGB = 'rgb(29, 78, 216)';
const BRAND_RGB = 'rgb(190, 18, 60)';
const LIGHT_BLUE_RGB = 'rgb(37, 99, 235)';

test.describe.configure({ timeout: 120_000 });

let nuxt: NuxtServer;
let workDir: string;
let original: string;
let originalApp: string;

async function circle(page: Page, element: Locator): Promise<void> {
  const box = await element.boundingBox();
  if (!box) throw new Error('the element is not visible');
  const left = box.x - 18;
  const right = box.x + box.width + 18;
  const top = box.y - 14;
  const bottom = box.y + box.height + 14;
  await page.mouse.move(left, top + 10);
  await page.mouse.down();
  for (const [x, y] of [
    [left + 30, top],
    [right, top + 6],
    [right - 4, bottom],
    [left + 6, bottom - 2],
    [left, top + 14],
  ] as const) {
    await page.mouse.move(x, y, { steps: 6 });
  }
  await page.mouse.up();
}

async function chooseTool(page: Page, name: 'Select' | 'Draw'): Promise<void> {
  await openFixture(page, nuxt.url);
  const tool = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(NUXT_DIR);
  workDir = await mkdtemp(join(tmpdir(), 'guijam-nuxt-'));
  original = await readFile(ORDER_BUTTON, 'utf8');
  originalApp = await readFile(APP, 'utf8');
  nuxt = await startNuxt(NUXT_DIR, {
    GUIJAM_GJD_BIN: GJD_BINARY,
    GUIJAM_FAKE_CLAUDE_LOG: join(workDir, 'runs.jsonl'),
    PATH: searchPath(FAKE_CLI_DIR, process.env.PATH),
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
  if ((await readFile(APP, 'utf8')) !== originalApp) await writeFile(APP, originalApp);
});

test.afterAll(async () => {
  await nuxt?.stop();
  await stopDaemon(NUXT_DIR);
  await rm(workDir, { recursive: true, force: true });
});

test('server-rendered nuxt pages carry project-relative source locations', async ({ page }) => {
  const html = await (await fetch(nuxt.url)).text();
  expect(html).toContain('data-gj-src="app/components/OrderButton.vue:3:5"');

  await openFixture(page, nuxt.url);

  await expect(page.getByRole('button', { name: 'Order now' })).toHaveAttribute(
    'data-gj-src',
    'app/components/OrderButton.vue:3:5',
  );
  await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toBeVisible();
  expect(nuxt.output()).not.toMatch(/Sourcemap for .* points to missing source files/);
});

test('fine-tuning a nuxt component previews live, applies and undoes', async ({ page }) => {
  await chooseTool(page, 'Select');
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune app/components/OrderButton.vue' });
  const hex = panel
    .getByRole('region', { name: 'Fill' })
    .getByRole('textbox', { name: 'Fill hex' });
  await expect(hex).toHaveValue('BE123C', { timeout: 30_000 });

  await hex.fill('1d4ed8');

  await expect(button).toHaveCSS('background-color', BLUE_RGB);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Applied to OrderButton.vue.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(
    original.replace('rounded-lg bg-brand px-6', 'rounded-lg bg-[#1D4ED8] px-6'),
  );
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Change undone.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});

test('a drawn prompt previews a variant on a nuxt page and Use writes it', async ({ page }) => {
  await chooseTool(page, 'Draw');
  const button = page.getByRole('button', { name: 'Order now' });
  await circle(page, button);
  const prompt = page.getByRole('dialog', { name: 'Ask AI app/components/OrderButton.vue' });
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it feel more premium');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(button).toHaveCSS('background-color', LIGHT_BLUE_RGB);

  await variants.getByRole('button', { name: 'Use V1' }).click();

  await expect(page.getByRole('status')).toContainText('Applied to OrderButton.vue.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original.replace('bg-brand', 'bg-[#2563EB]'));
});

test('Shift+click puts two components in one prompt, and Use and Undo cover both files', async ({
  page,
}) => {
  await openFixture(page, nuxt.url);
  await chooseTool(page, 'Select');
  await promptForTwo(
    page,
    {
      element: page.getByRole('button', { name: 'Order now' }),
      file: 'app/components/OrderButton.vue',
      path: ORDER_BUTTON,
    },
    { element: page.getByRole('heading', { level: 1 }), file: 'app/app.vue', path: APP },
  );
});

test('a sketch over a component undoes and redoes strokes, then generates', async ({ page }) => {
  await openFixture(page, nuxt.url);
  await chooseTool(page, 'Select');
  await sketchWithUndo(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'app/components/OrderButton.vue',
    path: ORDER_BUTTON,
  });
});

test('the h1 text is edited without AI, previewed, applied and undone', async ({ page }) => {
  await openFixture(page, nuxt.url);
  await chooseTool(page, 'Select');
  await editText(page, {
    element: page.getByRole('heading', { level: 1 }),
    file: 'app/app.vue',
    path: APP,
  });
});

test('a heading rendered from a data array is edited where the array is written', async ({
  page,
}) => {
  await openFixture(page, nuxt.url);
  await chooseTool(page, 'Select');
  await editFoundText(page, {
    element: page.locator('#extras h4'),
    file: 'app/components/Extras.vue',
    path: EXTRAS,
    caption: 'From TABS · Extras.vue:9',
  });
});

test('the Fill picker applies a theme color and Undo restores it', async ({ page }) => {
  await openFixture(page, nuxt.url);
  await chooseTool(page, 'Select');
  await pickThemeColor(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'app/components/OrderButton.vue',
    path: ORDER_BUTTON,
  });
});
