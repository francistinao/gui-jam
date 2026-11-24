import { readFile, writeFile } from 'node:fs/promises';
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
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';
import {
  expectTipAfterDelay,
  headerButtons,
  hideAndShowSketch,
  inked,
  sketchToggle,
  tipOf,
} from './support/new-features.js';
import { searchPath } from './support/process.js';
import { drawStroke, type Point, savedStrokes } from './support/strokes.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const APP_FILE = 'src/App.tsx';
const SKETCH = 'Sketch what you want for this component';
const READY_MS = 20_000;
const WATCHED = [ORDER_BUTTON_FILE, APP_FILE];

let fixture: FixtureServer;
const originals = new Map<string, string>();
const savedEnv = { PATH: process.env.PATH };

function orderButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Order now' });
}

function heading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

function askAI(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Ask AI ${file}` });
}

function tiles(prompt: Locator): Locator {
  return prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('group', { name: 'Pick a variant' })
    .getByRole('button');
}

function badge(page: Page, number: number): Locator {
  return page.getByRole('button', { name: new RegExp(`^Drawing ${number}: `) });
}

async function chooseTool(page: Page, name: 'Draw' | 'Select object'): Promise<void> {
  await openFixture(page, fixture.url);
  const tool = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

async function scribble(page: Page, element: Locator, down = 0.5): Promise<void> {
  const box = await element.boundingBox();
  if (!box) throw new Error('not visible');
  const points: Point[] = [
    [box.x + box.width * 0.15, box.y + box.height * down],
    [box.x + box.width * 0.85, box.y + box.height * down],
  ];
  await drawStroke(page, points);
}

async function sketchAndGenerate(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  await page
    .getByRole('dialog', { name: `Fine-tune ${file}` })
    .getByRole('button', { name: SKETCH })
    .click();
  const prompt = askAI(page, file);
  await expect(prompt).toBeVisible();
  await scribble(page, element, 0.3);
  await scribble(page, element, 0.7);
  await expect.poll(async () => (await savedStrokes(page)).at(-1)).toBe(2);
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('match my sketch');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  return prompt;
}

async function circle(page: Page, element: Locator): Promise<void> {
  const box = await element.boundingBox();
  if (!box) throw new Error('not visible');
  const left = box.x - 18;
  const right = box.x + box.width + 18;
  const top = box.y - 14;
  const bottom = box.y + box.height + 14;
  await drawStroke(page, [
    [left, top + 10],
    [left + 30, top],
    [right, top + 6],
    [right - 4, bottom],
    [left + 6, bottom - 2],
    [left, top + 14],
  ]);
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  for (const file of WATCHED) originals.set(file, await readFile(fixturePath(file), 'utf8'));
  await waitForDaemon(widgetRequests(fixture.api), { file: ORDER_BUTTON_FILE, line: 3, column: 5 });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  for (const [file, content] of originals) {
    const path = fixturePath(file);
    if ((await readFile(path, 'utf8')) !== content) await writeFile(path, content);
  }
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('the eye beside Close hides and shows a sketch over its variants, with a delayed tip, through a reload', async ({
  page,
}) => {
  await chooseTool(page, 'Select object');
  await hideAndShowSketch(page, {
    element: orderButton(page),
    file: ORDER_BUTTON_FILE,
    path: fixturePath(ORDER_BUTTON_FILE),
  });
});

test('each drawing hides only its own sketch, and each panel shows its own state', async ({
  page,
}) => {
  await chooseTool(page, 'Select object');
  const first = await sketchAndGenerate(page, orderButton(page), ORDER_BUTTON_FILE);
  const one = await inked(page);
  const second = await sketchAndGenerate(page, heading(page), APP_FILE);
  await expect.poll(() => inked(page)).toBeGreaterThan(one);
  const both = await inked(page);

  await sketchToggle(second, 'Hide sketch').click();

  await expect.poll(() => inked(page)).toBe(one);
  await badge(page, 1).click();
  await expect(sketchToggle(first, 'Hide sketch')).toBeVisible();
  await sketchToggle(first, 'Hide sketch').click();
  await expect.poll(() => inked(page)).toBe(0);
  await badge(page, 2).click();
  await expect(sketchToggle(second, 'Show sketch')).toBeVisible();
  await sketchToggle(second, 'Show sketch').click();
  await expect.poll(() => inked(page)).toBe(both - one);
  await badge(page, 1).click();
  await expect(sketchToggle(first, 'Show sketch')).toBeVisible();
  await sketchToggle(first, 'Show sketch').click();
  await expect.poll(() => inked(page)).toBe(both);
});

test('a circle drawn with the Draw tool gets the eye once its variants show', async ({ page }) => {
  await chooseTool(page, 'Draw');
  await circle(page, orderButton(page));
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await expect.poll(() => inked(page)).toBeGreaterThan(0);
  const drawn = await inked(page);
  await expect(sketchToggle(prompt, 'Hide sketch')).toHaveCount(0);
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it blue with a soft shadow');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });

  await sketchToggle(prompt, 'Hide sketch').click();

  await expect.poll(() => inked(page)).toBe(0);
  await sketchToggle(prompt, 'Show sketch').click();
  await expect.poll(() => inked(page)).toBe(drawn);
  await prompt.getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => inked(page)).toBe(0);
});

test('Edit prompt brings a hidden sketch back for editing, and new variants start with it shown', async ({
  page,
}) => {
  await chooseTool(page, 'Select object');
  const prompt = await sketchAndGenerate(page, orderButton(page), ORDER_BUTTON_FILE);
  const drawn = await inked(page);
  await sketchToggle(prompt, 'Hide sketch').click();
  await expect.poll(() => inked(page)).toBe(0);

  await prompt.getByRole('button', { name: 'Edit prompt' }).click();

  await expect.poll(() => inked(page)).toBe(drawn);
  await expect(prompt.locator('header').getByRole('button', { name: /sketch$/ })).toHaveCount(0);
  await scribble(page, orderButton(page), 0.5);
  await expect.poll(async () => (await savedStrokes(page)).at(-1)).toBe(3);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  await expect(sketchToggle(prompt, 'Hide sketch')).toBeVisible();
  await expect.poll(() => inked(page)).toBeGreaterThan(drawn);
  await prompt.getByRole('button', { name: 'Discard' }).click();
});

test('Use writes the variant and takes the hidden sketch away, and Undo restores the file', async ({
  page,
}) => {
  await chooseTool(page, 'Select object');
  const prompt = await sketchAndGenerate(page, orderButton(page), ORDER_BUTTON_FILE);
  await sketchToggle(prompt, 'Hide sketch').click();
  await expect.poll(() => inked(page)).toBe(0);

  await prompt.getByRole('button', { name: 'Use V1' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' });
  await expect(toast).toBeVisible();
  expect(await readFile(fixturePath(ORDER_BUTTON_FILE), 'utf8')).toContain('data-sketched="V1"');
  await expect(prompt).toHaveCount(0);
  await expect(badge(page, 1)).toHaveCount(0);
  expect(await inked(page)).toBe(0);

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect
    .poll(() => readFile(fixturePath(ORDER_BUTTON_FILE), 'utf8'))
    .toBe(originals.get(ORDER_BUTTON_FILE));
});

test('keyboard focus on the eye shows the same tip after the delay', async ({ page }) => {
  await chooseTool(page, 'Select object');
  const prompt = await sketchAndGenerate(page, orderButton(page), ORDER_BUTTON_FILE);
  await prompt.getByRole('button', { name: 'Move panel' }).focus();
  await page.keyboard.press('Tab');
  await expect(sketchToggle(prompt, 'Hide sketch')).toBeFocused();
  const tip = tipOf(prompt);
  await page.waitForTimeout(1_000);
  await expect(tip).toBeHidden();
  await expect(tip).toBeVisible({ timeout: 2_500 });
  await expect(tip).toHaveText('Hide sketch');

  await page.keyboard.press('Enter');

  await expect(sketchToggle(prompt, 'Show sketch')).toBeFocused();
  await expect.poll(() => inked(page)).toBe(0);
  await prompt.getByRole('button', { name: 'Discard' }).click();
});

test('the tip waits for the hover delay every time and hides as soon as the pointer leaves', async ({
  page,
}) => {
  await chooseTool(page, 'Select object');
  const prompt = await sketchAndGenerate(page, orderButton(page), ORDER_BUTTON_FILE);
  await expectTipAfterDelay(
    page,
    sketchToggle(prompt, 'Hide sketch'),
    tipOf(prompt),
    'Hide sketch',
  );
  await expectTipAfterDelay(
    page,
    sketchToggle(prompt, 'Hide sketch'),
    tipOf(prompt),
    'Hide sketch',
  );
  await prompt.getByRole('button', { name: 'Discard' }).click();
});

test('an Ask AI drawing without strokes has no eye', async ({ page }) => {
  await chooseTool(page, 'Select object');
  await orderButton(page).click();
  await page
    .getByRole('dialog', { name: `Fine-tune ${ORDER_BUTTON_FILE}` })
    .getByRole('button', { name: 'Ask AI', exact: true })
    .click();
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it blue with a soft shadow');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });

  expect(await headerButtons(prompt)).toEqual(['Move panel', 'Close']);
  await prompt.getByRole('button', { name: 'Discard' }).click();
});
