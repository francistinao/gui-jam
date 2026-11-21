import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import {
  FIXTURE_DIR,
  type FixtureServer,
  fileSnapshot,
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';
import { searchPath } from './support/process.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const APP = fixturePath('src/App.tsx');
const MENU_CARD = fixturePath('src/components/MenuCard.tsx');
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const MENU_CARD_FILE = 'src/components/MenuCard.tsx';
const READY_MS = 20_000;

let fixture: FixtureServer;
let cliLog: string;
const originals = new Map<string, string>();
const savedEnv = { PATH: process.env.PATH };

function selectTool(page: Page): Locator {
  return page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
}

function finetune(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${file}` });
}

function askAI(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Ask AI ${file}` });
}

function textbox(dialog: Locator): Locator {
  return dialog.getByRole('textbox', { name: 'Describe the change' });
}

function tiles(dialog: Locator): Locator {
  return dialog.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
}

function badges(page: Page): Locator {
  return page.getByRole('button', { name: /^Drawing \d/ });
}

function orderNow(page: Page): Locator {
  return page.getByRole('button', { name: 'Order now' });
}

function heading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

async function startSelecting(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  await selectTool(page).click();
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  cliLog = join(await mkdtemp(join(tmpdir(), 'guijam-fake-claude-')), 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  for (const file of [ORDER_BUTTON, APP, MENU_CARD]) {
    originals.set(file, await readFile(file, 'utf8'));
  }
  await waitForDaemon(widgetRequests(fixture.api), {
    file: ORDER_BUTTON_FILE,
    line: 3,
    column: 5,
  });
});

test.afterEach(async () => {
  for (const [file, content] of originals) {
    if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
  }
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

const BRAND_RGB = 'rgb(190, 18, 60)';
const BLUE_RGB = 'rgb(29, 78, 216)';
const ESPRESSO_RGB = 'rgb(59, 36, 24)';

function field(dialog: Locator, name = 'Text content'): Locator {
  return dialog.getByRole('textbox', { name, exact: true });
}

function drawTool(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
}

function picker(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Fill color picker' });
}

function applied(page: Page, file: string): Locator {
  return page.getByRole('status').filter({ hasText: `Applied to ${file}.` });
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

function changedLines(before: string, after: string): string[] {
  const old = before.split('\n');
  return after.split('\n').filter((line, index) => line !== old[index]);
}

test('a heading is edited live, Apply writes one line, and Undo restores the exact bytes', async ({
  page,
}) => {
  await startSelecting(page);
  const before = await fileSnapshot(APP);
  await heading(page).click();
  const panel = finetune(page, 'src/App.tsx');
  await expect(field(panel)).toHaveValue('Slow-roasted, made for mornings');

  await field(panel).fill('Freshly roasted, every morning');

  await expect(heading(page)).toHaveText('Freshly roasted, every morning');
  await expect(panel.getByText('Unsaved')).toBeVisible();
  await panel.getByRole('tab', { name: 'Code' }).click();
  await expect(panel.getByRole('tabpanel', { name: 'Code' })).toContainText(
    'Freshly roasted, every morning',
  );
  expect(await fileSnapshot(APP)).toEqual(before);

  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = applied(page, 'App.tsx');
  await expect(toast).toBeVisible();
  const written = await readFile(APP, 'utf8');
  expect(changedLines(before.content, written)).toEqual([
    '          <h1 className="font-display text-5xl font-bold">Freshly roasted, every morning</h1>',
  ]);
  await panel.getByRole('tab', { name: 'Design' }).click();
  await expect(field(panel)).toHaveValue('Freshly roasted, every morning');

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect.poll(() => readFile(APP, 'utf8')).toBe(before.content);
  await expect(heading(page)).toHaveText('Slow-roasted, made for mornings');
});

test('special characters are escaped in the file and entities are shown decoded', async ({
  page,
}) => {
  await startSelecting(page);
  const before = await fileSnapshot(APP);
  const brand = page.locator('header > span').first();
  await brand.click({ position: { x: 80, y: 10 } });
  const panel = finetune(page, 'src/App.tsx');
  await expect(field(panel)).toHaveValue('Brew & Co.');
  await expect(panel.getByText('<img>')).toBeVisible();

  await field(panel).fill('Brew & Co. <Café> {x}');
  await field(panel).press('Enter');

  const toast = applied(page, 'App.tsx');
  await expect(toast).toBeVisible();
  expect(changedLines(before.content, await readFile(APP, 'utf8'))).toEqual([
    '          Brew &amp; Co. &lt;Café&gt; &#123;x&#125;',
  ]);
  await expect(brand).toHaveText('Brew & Co. <Café> {x}');
  await expect(brand.getByRole('img', { name: 'Coffee cup' })).toBeVisible();

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(APP, 'utf8')).toBe(before.content);
});

test('the Korean text next to a span is edited and the span stays', async ({ page }) => {
  await startSelecting(page);
  const before = await fileSnapshot(APP);
  const pick = page.locator('p', { has: page.getByText('Ube Latte', { exact: true }) });
  await pick.click({ position: { x: 10, y: 8 } });
  const panel = finetune(page, 'src/App.tsx');
  await expect(field(panel)).toHaveValue('오늘의 추천');
  await expect(panel.getByText('<span>')).toBeVisible();

  await field(panel).fill("Today's pick");

  await expect(pick).toHaveText("Today's pick Ube Latte");
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = applied(page, 'App.tsx');
  await expect(toast).toBeVisible();
  expect(changedLines(before.content, await readFile(APP, 'utf8'))).toEqual([
    `            Today's pick <span className="font-semibold text-brand">Ube Latte</span>`,
  ]);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(APP, 'utf8')).toBe(before.content);
});

test('text from code that cannot be traced shows its source and no field', async ({ page }) => {
  await startSelecting(page);
  await page.locator('#extras').getByText('₱250').click();
  const panel = finetune(page, 'src/components/Extras.tsx');
  const content = panel.getByRole('region', { name: 'Content' });
  await expect(content.getByText('{peso(250)}', { exact: true })).toBeVisible();
  await expect(content.getByText('Use Ask AI to change it.', { exact: false })).toBeVisible();
  await expect(content.getByRole('textbox')).toHaveCount(0);
});

test('a repeated label changes on every instance, and Esc reverts unsaved text', async ({
  page,
}) => {
  await startSelecting(page);
  const before = await fileSnapshot(MENU_CARD);
  const adds = page.getByRole('button', { name: 'Add', exact: true });
  await adds.first().click();
  const panel = finetune(page, MENU_CARD_FILE);
  await expect(panel.getByRole('note')).toContainText('Used 3× on this page.');

  await field(panel).fill('Add to cart');

  await expect(page.getByRole('button', { name: 'Add to cart' })).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('status').filter({ hasText: 'Unsaved tweaks were reverted.' }),
  ).toBeVisible();
  await expect(adds).toHaveCount(3);
  expect(await fileSnapshot(MENU_CARD)).toEqual(before);
});

test('a Draw circle offers the text field, and Apply text closes the drawing', async ({ page }) => {
  await openFixture(page, fixture.url);
  await drawTool(page).click();
  const before = await fileSnapshot(ORDER_BUTTON);
  await circle(page, orderNow(page));
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await expect(field(prompt)).toHaveValue('Order now');

  await field(prompt).fill('Order today');

  await expect(page.getByRole('button', { name: 'Order today' })).toBeVisible();
  await prompt.getByRole('button', { name: 'Apply text' }).click();

  const toast = applied(page, 'OrderButton.tsx');
  await expect(toast).toBeVisible();
  await expect(prompt).toHaveCount(0);
  await expect(badges(page)).toHaveCount(0);
  expect(changedLines(before.content, await readFile(ORDER_BUTTON, 'utf8'))).toEqual([
    '      Order today',
  ]);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
});

test('Generate reverts an unsaved text edit before asking the AI', async ({ page }) => {
  await openFixture(page, fixture.url);
  await drawTool(page).click();
  await circle(page, orderNow(page));
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await field(prompt).fill('Order today');
  await expect(page.getByRole('button', { name: 'Order today' })).toBeVisible();

  await textbox(prompt).fill('make it feel more premium');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Unsaved tweaks were reverted.' }),
  ).toBeVisible();
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(orderNow(page)).toBeVisible();
});

test('the Fill picker sets an exact color in RGB, previews it, and Apply and Undo restore it', async ({
  page,
}) => {
  await startSelecting(page);
  const before = await fileSnapshot(ORDER_BUTTON);
  await orderNow(page).click();
  const panel = finetune(page, ORDER_BUTTON_FILE);
  await panel.getByRole('button', { name: 'Fill color' }).click();
  const colors = picker(page);
  await expect(colors).toBeVisible();
  await expect(colors.getByRole('textbox', { name: 'Hex' })).toHaveValue('BE123C');

  await colors.getByRole('combobox', { name: 'Color mode' }).selectOption('rgb');
  for (const [name, value] of [
    ['Red', '29'],
    ['Green', '78'],
    ['Blue', '216'],
  ] as const) {
    const input = colors.getByRole('textbox', { name, exact: true });
    await input.fill(value);
    await input.press('Tab');
  }

  await expect(orderNow(page)).toHaveCSS('background-color', BLUE_RGB);
  await expect(panel.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('1D4ED8');
  await colors.getByRole('textbox', { name: 'Red', exact: true }).press('Escape');
  await expect(colors).toHaveCount(0);
  await expect(panel).toBeVisible();

  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = applied(page, 'OrderButton.tsx');
  await expect(toast).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('bg-[#1D4ED8]');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
});

test('dragging the color square and the hue and opacity sliders changes the color live', async ({
  page,
}) => {
  await startSelecting(page);
  const before = await fileSnapshot(ORDER_BUTTON);
  await orderNow(page).click();
  const panel = finetune(page, ORDER_BUTTON_FILE);
  await panel.getByRole('button', { name: 'Fill color' }).click();
  const colors = picker(page);
  const hex = colors.getByRole('textbox', { name: 'Hex' });

  const area = colors.locator('[data-saturation-area]');
  const box = await area.boundingBox();
  if (!box) throw new Error('the color square is not visible');
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + 2, box.y + box.height - 2, { steps: 5 });
  await page.mouse.up();
  await expect(hex).not.toHaveValue('BE123C');
  await expect(orderNow(page)).not.toHaveCSS('background-color', BRAND_RGB);

  const hue = colors.getByRole('slider', { name: 'Hue' });
  await hue.focus();
  await hue.press('Home');
  await expect(colors.getByRole('slider', { name: 'Saturation and brightness' })).toBeVisible();
  const opacity = colors.getByRole('slider', { name: 'Opacity' });
  await opacity.focus();
  await opacity.press('Home');
  await expect(colors.getByRole('textbox', { name: 'Opacity percent' })).toHaveValue('0');
  await expect(orderNow(page)).toHaveCSS('background-color', /rgba\(.*, 0\)/);

  await colors.getByRole('button', { name: 'Theme color espresso' }).click();
  await expect(orderNow(page)).toHaveCSS('background-color', ESPRESSO_RGB);
  await expect(colors.getByRole('button', { name: 'Theme color espresso' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = applied(page, 'OrderButton.tsx');
  await expect(toast).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('bg-espresso');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
});

test('the eyedropper picks a color from the screen, and canceling it changes nothing', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let calls = 0;
    Object.assign(window, {
      EyeDropper: class {
        open(): Promise<{ sRGBHex: string }> {
          calls += 1;
          return calls === 1
            ? Promise.resolve({ sRGBHex: '#1d4ed8' })
            : Promise.reject(new DOMException('canceled', 'AbortError'));
        }
      },
    });
  });
  await startSelecting(page);
  await orderNow(page).click();
  const panel = finetune(page, ORDER_BUTTON_FILE);
  await panel.getByRole('button', { name: 'Fill color' }).click();
  const colors = picker(page);

  await colors.getByRole('button', { name: 'Pick a color from the screen' }).click();
  await expect(colors.getByRole('textbox', { name: 'Hex' })).toHaveValue('1D4ED8');
  await expect(orderNow(page)).toHaveCSS('background-color', BLUE_RGB);

  await colors.getByRole('button', { name: 'Pick a color from the screen' }).click();
  await expect(colors.getByRole('textbox', { name: 'Hex' })).toHaveValue('1D4ED8');
  await panel.getByRole('button', { name: 'Revert' }).click();
  await expect(orderNow(page)).toHaveCSS('background-color', BRAND_RGB);
});
