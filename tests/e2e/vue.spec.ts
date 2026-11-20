import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  GJD_BINARY,
  requireDaemonBinary,
  stopDaemon,
  waitForDaemon,
  widgetRequests,
} from './support/daemon.js';
import { type FixtureServer, openFixture, startFixtureServer } from './support/fixture.js';
import { editText, pickThemeColor, promptForTwo, sketchWithUndo } from './support/new-features.js';
import { searchPath } from './support/process.js';

const VUE_DIR = fileURLToPath(new URL('../../fixtures/small-vue-tailwind4/', import.meta.url));
const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = join(VUE_DIR, 'src/components/OrderButton.vue');
const APP = join(VUE_DIR, 'src/App.vue');
const BLUE_RGB = 'rgb(29, 78, 216)';
const BRAND_RGB = 'rgb(190, 18, 60)';
const LIGHT_BLUE_RGB = 'rgb(37, 99, 235)';

let fixture: FixtureServer;
let workDir: string;
const originals = new Map<string, string>();
const savedPath = process.env.PATH;

async function select(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  const tool = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

async function pick(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  const panel = page.getByRole('dialog', { name: `Fine-tune ${file}` });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
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

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(VUE_DIR);
  workDir = await mkdtemp(join(tmpdir(), 'guijam-vue-'));
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = join(workDir, 'runs.jsonl');
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedPath);
  for (const file of [ORDER_BUTTON, APP]) originals.set(file, await readFile(file, 'utf8'));
  fixture = await startFixtureServer(undefined, VUE_DIR);
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.vue',
    line: 3,
    column: 5,
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  for (const [file, content] of originals) {
    if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
  }
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(VUE_DIR);
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedPath;
  await rm(workDir, { recursive: true, force: true });
});

test('vue templates carry source locations for native elements only', async ({ page }) => {
  await openFixture(page, fixture.url);

  await expect(page.getByRole('button', { name: 'Order now' })).toHaveAttribute(
    'data-gj-src',
    'src/components/OrderButton.vue:3:5',
  );
  await expect(page.getByText('Gift cards for every occasion')).toHaveAttribute(
    'data-gj-src',
    'src/App.vue:19:9',
  );
  await expect(page.getByRole('link', { name: 'Branches' })).toHaveAttribute(
    'data-gj-src',
    'src/App.vue:9:9',
  );
  expect(await page.locator('[data-gj-src*="OrderButton"]').count()).toBe(3);
});

test('fine-tuning a vue element edits its class, previews live and undoes exactly', async ({
  page,
}) => {
  await select(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const panel = await pick(page, button, 'src/components/OrderButton.vue');
  const fill = panel.getByRole('region', { name: 'Fill' });
  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('BE123C');
  const before = await readFile(ORDER_BUTTON, 'utf8');

  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');

  await expect(button).toHaveCSS('background-color', BLUE_RGB);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Applied to OrderButton.vue.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(
    before.replace('rounded-lg bg-brand px-6', 'rounded-lg bg-[#1D4ED8] px-6'),
  );
  await expect(button).toHaveCSS('background-color', BLUE_RGB);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Change undone.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});

test('an inline style attribute in a vue template is edited as CSS', async ({ page }) => {
  await select(page);
  const gift = page.getByText('Gift cards for every occasion');
  const panel = await pick(page, gift, 'src/App.vue');
  await expect(
    panel.getByRole('region', { name: 'Fill' }).getByRole('textbox', { name: 'Fill hex' }),
  ).toHaveValue('FDE68A');
  const before = await readFile(APP, 'utf8');

  await panel
    .getByRole('region', { name: 'Fill' })
    .getByRole('textbox', { name: 'Fill hex' })
    .fill('1d4ed8');
  await expect(gift).toHaveCSS('background-color', BLUE_RGB);
  await panel.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByRole('status')).toContainText('Applied to App.vue.');
  expect(await readFile(APP, 'utf8')).toBe(
    before.replace(
      'style="background-color: #fde68a; border-radius: 8px; padding: 16px"',
      'style="background-color: #1D4ED8; border-radius: 8px; padding: 16px"',
    ),
  );
});

test('a drawn prompt previews a variant in the vue file and Use writes it', async ({ page }) => {
  await openFixture(page, fixture.url);
  const draw = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  const button = page.getByRole('button', { name: 'Order now' });
  await circle(page, button);
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.vue' });
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it feel more premium');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  await expect(button).toHaveCSS('background-color', LIGHT_BLUE_RGB);
  const before = await readFile(ORDER_BUTTON, 'utf8');
  expect(before).toContain('bg-brand');

  await variants.getByRole('button', { name: 'Use V1' }).click();

  await expect(page.getByRole('status')).toContainText('Applied to OrderButton.vue.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.replace('bg-brand', 'bg-[#2563EB]'));
});

test('Shift+click puts two components in one prompt, and Use and Undo cover both files', async ({
  page,
}) => {
  await select(page);
  await promptForTwo(
    page,
    {
      element: page.getByRole('button', { name: 'Order now' }),
      file: 'src/components/OrderButton.vue',
      path: ORDER_BUTTON,
    },
    { element: page.getByRole('heading', { level: 1 }), file: 'src/App.vue', path: APP },
  );
});

test('a sketch over a component undoes and redoes strokes, then generates', async ({ page }) => {
  await select(page);
  await sketchWithUndo(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.vue',
    path: ORDER_BUTTON,
  });
});

test('the h1 text is edited without AI, previewed, applied and undone', async ({ page }) => {
  await select(page);
  await editText(page, {
    element: page.getByRole('heading', { level: 1 }),
    file: 'src/App.vue',
    path: APP,
  });
});

test('the Fill picker applies a theme color and Undo restores it', async ({ page }) => {
  await select(page);
  await pickThemeColor(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.vue',
    path: ORDER_BUTTON,
  });
});
