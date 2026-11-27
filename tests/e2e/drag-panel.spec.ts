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
import { dragPanel, inked, settlesAt, sketchToggle, steadyBox } from './support/new-features.js';
import { searchPath } from './support/process.js';
import { drawStroke, savedStrokes } from './support/strokes.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const APP_FILE = 'src/App.tsx';
const SKETCH = 'Sketch what you want for this component';
const READY_MS = 20_000;
const EDGE = 12;
const WATCHED = [ORDER_BUTTON_FILE, APP_FILE];

let fixture: FixtureServer;
const originals = new Map<string, string>();
const savedEnv = { PATH: process.env.PATH };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function orderButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Order now' });
}

function heading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

function finetune(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${file}` });
}

function askAI(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Ask AI ${file}` });
}

function badge(page: Page, number: number): Locator {
  return page.getByRole('button', { name: new RegExp(`^Drawing ${number}: `) });
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not visible');
  return box;
}

async function selecting(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  const tool = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

async function dragHeader(page: Page, panel: Locator, dx: number, dy: number): Promise<void> {
  const header = await boxOf(panel.locator('header'));
  const x = header.x + 24;
  const y = header.y + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function dragTo(page: Page, panel: Locator, x: number, y: number): Promise<void> {
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  const box = await steadyBox(page, panel);
  await dragHeader(page, panel, x - box.x, y - box.y);
  await settlesAt(panel, x, y);
}

async function askAbout(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  await finetune(page, file).getByRole('button', { name: 'Ask AI', exact: true }).click();
  const prompt = askAI(page, file);
  await expect(prompt).toBeVisible();
  return prompt;
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

test('a panel is dragged by its header, stays put on scroll, fits a smaller window, hands its spot to Ask AI and resets', async ({
  page,
}) => {
  await selecting(page);
  await dragPanel(page, {
    element: orderButton(page),
    file: ORDER_BUTTON_FILE,
    path: fixturePath(ORDER_BUTTON_FILE),
  });
});

test('moving the panel while sketching adds no stroke, and the spot it left can be drawn on', async ({
  page,
}) => {
  await selecting(page);
  await orderButton(page).click();
  await finetune(page, ORDER_BUTTON_FILE).getByRole('button', { name: SKETCH }).click();
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await expect(prompt).toBeVisible();
  const button = await boxOf(orderButton(page));
  await drawStroke(page, [
    [button.x + 4, button.y + button.height / 2],
    [button.x + button.width - 4, button.y + button.height / 2],
  ]);
  await expect.poll(async () => (await savedStrokes(page)).at(-1)).toBe(1);
  const one = await inked(page);
  const left = await boxOf(prompt);

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const away = left.x - left.width - 40 >= EDGE ? -(left.width + 40) : left.width + 40;
  expect(left.x + away + left.width).toBeLessThanOrEqual(viewport.width - EDGE);
  await dragHeader(page, prompt, away, 0);

  await settlesAt(prompt, left.x + away, left.y);
  expect((await savedStrokes(page)).at(-1)).toBe(1);
  expect(await inked(page)).toBe(one);

  const middle = left.y + Math.min(left.height, 200) / 2;
  await drawStroke(page, [
    [left.x + 30, middle],
    [left.x + left.width - 30, middle + 20],
  ]);

  await expect.poll(async () => (await savedStrokes(page)).at(-1)).toBe(2);
  await expect.poll(() => inked(page)).toBeGreaterThan(one);
  await prompt.locator('header').getByRole('button', { name: 'Close' }).click();
});

test('each drawing keeps its own spot, a new drawing opens beside itself, and its badge reopens it where it was', async ({
  page,
}) => {
  await selecting(page);
  const first = await askAbout(page, orderButton(page), ORDER_BUTTON_FILE);
  await dragTo(page, first, 40, 300);

  const second = await askAbout(page, heading(page), APP_FILE);
  await expect(second).not.toHaveAttribute('data-moved');
  const beside = await boxOf(second);

  await badge(page, 1).click();
  await expect(first).toHaveAttribute('data-moved', '');
  await settlesAt(first, 40, 300);

  await badge(page, 2).click();
  await expect(second).not.toHaveAttribute('data-moved');
  await settlesAt(second, beside.x, beside.y);

  await dragTo(page, second, 600, 60);
  await badge(page, 1).click();
  await settlesAt(first, 40, 300);
  await badge(page, 2).click();
  await settlesAt(second, 600, 60);
});

test('a moved panel comes back to its spot after a reload, pulled inside a smaller window', async ({
  page,
}) => {
  await selecting(page);
  const prompt = await askAbout(page, orderButton(page), ORDER_BUTTON_FILE);
  await dragTo(page, prompt, 900, 300);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(sessionStorage.getItem('guijam:jobs') ?? '{}') as {
          jobs?: { panelAt: unknown }[];
        };
        return saved.jobs?.[0]?.panelAt;
      }),
    )
    .toEqual({ left: 900, top: 300 });

  await page.reload();

  await expect(prompt).toHaveAttribute('data-moved', '', { timeout: READY_MS });
  await settlesAt(prompt, 900, 300);
  await page.setViewportSize({ width: 800, height: 500 });
  await expect.poll(async () => (await boxOf(prompt)).x).toBe(800 - 300 - EDGE);
  const squeezed = await boxOf(prompt);
  expect(squeezed.y + Math.min(squeezed.height, 240)).toBeLessThanOrEqual(500 - EDGE + 1);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(async () => (await boxOf(prompt)).x).toBe(900);
});

test('variants arriving do not move a moved panel, it scrolls inside the room below it', async ({
  page,
}) => {
  await selecting(page);
  const prompt = await askAbout(page, orderButton(page), ORDER_BUTTON_FILE);
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const top = viewport.height - 300;
  await dragTo(page, prompt, 40, top);
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it blue with a soft shadow');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(
    prompt.getByRole('region', { name: 'Variants' }).getByRole('group', { name: 'Pick a variant' }),
  ).toBeAttached({ timeout: READY_MS });

  await settlesAt(prompt, 40, top);
  const grown = await boxOf(prompt);
  expect(grown.y + grown.height).toBeLessThanOrEqual(viewport.height - EDGE + 1);
  expect(await prompt.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await prompt.getByRole('button', { name: 'Discard' }).click();
});

test('double-clicking a header button does its job and leaves the moved panel where it is', async ({
  page,
}) => {
  await selecting(page);
  await orderButton(page).click();
  await finetune(page, ORDER_BUTTON_FILE).getByRole('button', { name: SKETCH }).click();
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  const button = await boxOf(orderButton(page));
  await drawStroke(page, [
    [button.x + 4, button.y + button.height / 2],
    [button.x + button.width - 4, button.y + button.height / 2],
  ]);
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('match my sketch');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(sketchToggle(prompt, 'Hide sketch')).toBeVisible({ timeout: READY_MS });
  await dragTo(page, prompt, 60, 120);

  await sketchToggle(prompt, 'Hide sketch').dblclick();

  await expect(sketchToggle(prompt, 'Hide sketch')).toBeVisible();
  await expect(prompt).toHaveAttribute('data-moved', '');
  await settlesAt(prompt, 60, 120);
  await prompt.getByRole('button', { name: 'Discard' }).click();
});

test('a new selection opens beside its element, not where the last panel was moved', async ({
  page,
}) => {
  await selecting(page);
  await orderButton(page).click();
  const panel = finetune(page, ORDER_BUTTON_FILE);
  await dragTo(page, panel, 40, 400);

  await heading(page).click();

  const other = finetune(page, APP_FILE);
  await expect(other).toBeVisible();
  await expect(other).not.toHaveAttribute('data-moved');
  await page.keyboard.press('Escape');
  await expect(other).toHaveCount(0);

  await orderButton(page).click();
  await expect(panel).not.toHaveAttribute('data-moved');
});

test('the same element clicked again keeps its moved Fine-tune panel', async ({ page }) => {
  await selecting(page);
  await orderButton(page).click();
  const panel = finetune(page, ORDER_BUTTON_FILE);
  await dragTo(page, panel, 40, 400);

  await orderButton(page).click({ position: { x: 6, y: 6 } });

  await expect(panel).toHaveAttribute('data-moved', '');
  await settlesAt(panel, 40, 400);
});

test('Escape still closes a moved panel', async ({ page }) => {
  await selecting(page);
  const prompt = await askAbout(page, orderButton(page), ORDER_BUTTON_FILE);
  await dragTo(page, prompt, 40, 300);

  await page.keyboard.press('Escape');

  await expect(prompt).toHaveCount(0);
  await expect(badge(page, 1)).toHaveCount(0);
});

test('dragging inside the prompt box selects text and leaves the panel where it is', async ({
  page,
}) => {
  await selecting(page);
  const prompt = await askAbout(page, orderButton(page), ORDER_BUTTON_FILE);
  const start = await boxOf(prompt);
  const box = prompt.getByRole('textbox', { name: 'Describe the change' });
  await box.fill('make the order button feel more premium');
  const field = await boxOf(box);

  await page.mouse.move(field.x + 8, field.y + 12);
  await page.mouse.down();
  await page.mouse.move(field.x + 140, field.y + 14, { steps: 8 });
  await page.mouse.up();

  expect(
    await box.evaluate(
      (element) =>
        (element as HTMLTextAreaElement).selectionEnd -
        (element as HTMLTextAreaElement).selectionStart,
    ),
  ).toBeGreaterThan(0);
  await expect(prompt).not.toHaveAttribute('data-moved');
  await settlesAt(prompt, start.x, start.y);
});

test('a drag cancelled by the browser puts the panel back', async ({ page }) => {
  await selecting(page);
  const prompt = await askAbout(page, orderButton(page), ORDER_BUTTON_FILE);
  const start = await boxOf(prompt);
  const header = prompt.locator('header');
  const grip = await boxOf(header);
  const x = grip.x + 24;
  const y = grip.y + 8;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y + 90, { steps: 8 });
  await settlesAt(prompt, start.x - 150, start.y + 90);
  await header.dispatchEvent('pointercancel', { pointerId: 1 });
  await settlesAt(prompt, start.x, start.y);
  await page.mouse.move(x - 40, y + 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  await settlesAt(prompt, start.x, start.y);

  await settlesAt(prompt, start.x, start.y);
  await expect(prompt).not.toHaveAttribute('data-moved');
});
