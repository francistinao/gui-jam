import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  GJD_BINARY,
  requireDaemonBinary,
  stopDaemon,
  waitForDaemon,
  widgetRequests,
} from '../e2e/support/daemon.js';
import {
  FIXTURE_DIR,
  type FixtureServer,
  fixturePath,
  openFixture,
  startFixtureServer,
} from '../e2e/support/fixture.js';
import { searchPath } from '../e2e/support/process.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const OUT_DIR =
  process.env.GUIJAM_SCREENSHOT_DIR ??
  fileURLToPath(new URL('../../test-results/screenshots/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const SETTLE_MS = 400;

let fixture: FixtureServer;
let original: string;
const savedPath = process.env.PATH;

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
}

async function chooseTool(page: Page, name: 'Draw' | 'Select'): Promise<void> {
  const tool = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

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

async function prompt(page: Page, request: string): Promise<Locator> {
  await chooseTool(page, 'Draw');
  await circle(page, page.getByRole('button', { name: 'Order now' }));
  const dialog = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  await dialog.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  return dialog;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  await mkdir(OUT_DIR, { recursive: true });
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedPath);
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  process.env.PATH = savedPath;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('toolbar and fine-tune', async ({ page }) => {
  await openFixture(page, fixture.url);
  await capture(page, 'toolbar');

  await chooseTool(page, 'Select');
  const button = page.getByRole('button', { name: 'Order now' });
  await button.hover();
  await capture(page, 'select-hover');

  await button.click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  await capture(page, 'finetune-design');

  await panel
    .getByRole('region', { name: 'Fill' })
    .getByRole('textbox', { name: 'Fill hex' })
    .fill('1D4ED8');
  await panel
    .getByRole('region', { name: 'Fill' })
    .getByRole('textbox', { name: 'Fill hex' })
    .press('Enter');
  await expect(panel.getByText('Unsaved')).toBeVisible();
  await capture(page, 'finetune-unsaved');

  await panel.getByRole('tab', { name: 'Code' }).click();
  await capture(page, 'finetune-code');
});

test('draw, variants and apply', async ({ page }) => {
  await openFixture(page, fixture.url);
  const dialog = await prompt(page, 'Make it blue with a soft shadow, linger');
  await capture(page, 'draw-prompt');

  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('list', { name: 'Progress' })).toBeVisible();
  await page.waitForTimeout(1200);
  await capture(page, 'progress');

  const variants = dialog.getByRole('region', { name: 'Variants' });
  await expect(variants).toBeVisible({ timeout: 20_000 });
  await capture(page, 'variants');

  await variants.getByRole('group', { name: 'Pick a variant' }).getByRole('button').nth(1).click();
  await variants.getByRole('button', { name: 'Use V2' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' }),
  ).toBeVisible();
  await capture(page, 'applied');
});

test('ask', async ({ page }) => {
  await openFixture(page, fixture.url);
  const dialog = await prompt(page, 'Where is this button rendered?');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('region', { name: 'Answer' })).toBeVisible({ timeout: 20_000 });
  await capture(page, 'answer');
});
