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
  openFixture,
  startFixtureServer,
} from './support/fixture.js';
import { drawStroke } from './support/strokes.js';

const FILE = 'src/components/FloatingDemo.tsx';
const EMPTY = [1220, 110] as const;

let fixture: FixtureServer;

function tool(page: Page, name: 'Select object' | 'Draw'): Locator {
  return page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name });
}

function finetune(page: Page): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${FILE}` });
}

function prompt(page: Page): Locator {
  return page.getByRole('dialog', { name: `Ask AI ${FILE}` });
}

async function open(page: Page): Promise<void> {
  await openFixture(page, `${fixture.url}?floating`);
}

async function choose(page: Page, name: 'Select object' | 'Draw'): Promise<void> {
  await tool(page, name).click();
  await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'true');
}

async function pickAndType(page: Page, element: Locator): Promise<Locator> {
  await element.click();
  await expect(finetune(page)).toBeVisible();
  await finetune(page).getByRole('button', { name: 'Ask AI', exact: true }).click();
  const box = prompt(page).getByRole('textbox', { name: 'Describe the change' });
  await box.click();
  await page.keyboard.type('make it /bigger');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('make it /bigger');
  return box;
}

async function circle(page: Page, element: Locator): Promise<void> {
  const box = await element.boundingBox();
  if (!box) throw new Error('the element is not visible');
  const [left, top] = [box.x - 12, box.y - 10];
  const [right, bottom] = [box.x + box.width + 12, box.y + box.height + 10];
  await drawStroke(page, [
    [left, top + 8],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top + 12],
  ]);
}

function popoverOpen(element: Locator): Promise<boolean> {
  return element.evaluate((node) => node.matches(':popover-open'));
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
    line: 3,
    column: 5,
  });
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('a Radix dialog stays open through Select, a pick, typing and Esc', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Open Radix dialog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Radix dialog' });
  await expect(dialog).toBeVisible();

  await choose(page, 'Select object');
  await expect(dialog).toBeVisible();
  await pickAndType(page, page.getByText('Radix dialog body'));
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(prompt(page)).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tool(page, 'Select object')).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status', { name: 'Hotkey presses' })).toHaveText('0');
});

test('a Radix popover and menu stay open while you draw on them and describe the change', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Open Radix popover' }).click();
  const body = page.getByText('Radix popover body');
  await expect(body).toBeVisible();
  await choose(page, 'Draw');
  await expect(body).toBeVisible();
  await circle(page, body);
  const box = prompt(page).getByRole('textbox', { name: 'Describe the change' });
  await box.fill('rounder corners');
  await expect(body).toBeVisible();

  await open(page);
  await page.getByRole('button', { name: 'Open Radix menu' }).click();
  const item = page.getByRole('menuitem', { name: 'Radix menu item' });
  await expect(item).toBeVisible();
  await choose(page, 'Draw');
  await circle(page, item);
  await prompt(page).getByRole('textbox', { name: 'Describe the change' }).fill('bolder');
  await expect(item).toBeVisible();
});

test('a tooltip picked in Select mode stays open while the pointer goes to the panel', async ({
  page,
}) => {
  await open(page);
  await choose(page, 'Select object');
  await page.getByRole('button', { name: 'Radix tooltip trigger' }).hover();
  const text = page.getByText('Radix tooltip text').first();
  await expect(text).toBeVisible();
  await text.hover();
  await text.click();
  await expect(finetune(page)).toBeVisible();

  await finetune(page).getByRole('button', { name: 'Ask AI', exact: true }).hover();
  await page.mouse.move(...EMPTY, { steps: 8 });
  await expect(text).toBeVisible();
});

test('Alt+Shift+D over a hovered tooltip starts drawing and the tooltip stays', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Radix tooltip trigger' }).hover();
  const text = page.getByText('Radix tooltip text').first();
  await expect(text).toBeVisible();

  await page.keyboard.press('Alt+Shift+KeyD');
  await expect(tool(page, 'Draw')).toHaveAttribute('aria-pressed', 'true');
  await expect(text).toBeVisible();
  await circle(page, text);
  await expect(prompt(page)).toBeVisible();
  await expect(text).toBeVisible();

  await page.keyboard.press('Alt+Shift+KeyS');
  await expect(tool(page, 'Select object')).toHaveAttribute('aria-pressed', 'true');
  await expect(tool(page, 'Draw')).toHaveAttribute('aria-pressed', 'false');
});

test('a native modal dialog keeps GUIJam above it and clickable', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Open native dialog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Native dialog' });
  await expect(dialog).toBeVisible();

  await choose(page, 'Select object');
  await pickAndType(page, page.getByText('Native dialog body'));
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => (node as HTMLDialogElement).open)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(prompt(page)).toBeHidden();
  expect(await dialog.evaluate((node) => (node as HTMLDialogElement).open)).toBe(true);
});

test('a native popover is not light-dismissed by GUIJam', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Open native popover' }).click();
  const popover = page.locator('#native-popover');
  await expect(popover).toBeVisible();

  await choose(page, 'Select object');
  expect(await popoverOpen(popover)).toBe(true);
  await pickAndType(page, page.getByText('Native popover body'));
  expect(await popoverOpen(popover)).toBe(true);
});

for (const label of ['Capture popover', 'Window popover'] as const) {
  test(`a ${label.toLowerCase()} that closes on outside presses stays open`, async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: `Open ${label}` }).click();
    const layer = page.getByRole('dialog', { name: label });
    await expect(layer).toBeVisible();

    await choose(page, 'Select object');
    await expect(layer).toBeVisible();
    await pickAndType(page, page.getByText(`${label} body`));
    await expect(layer).toBeVisible();
  });
}

test('a focus trap keeps its layer while GUIJam takes clicks and focus', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Open focus trap' }).click();
  const trap = page.getByRole('dialog', { name: 'Focus trap' });
  await expect(trap).toBeVisible();

  await choose(page, 'Select object');
  await pickAndType(page, page.getByText('Focus trap body'));
  await expect(trap).toBeVisible();
});

test('with GUIJam idle the page still dismisses its own layers', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Open Radix popover' }).click();
  await expect(page.getByText('Radix popover body')).toBeVisible();
  await page.mouse.click(...EMPTY);
  await expect(page.getByText('Radix popover body')).toBeHidden();

  await page.getByRole('button', { name: 'Open Radix dialog' }).click();
  await expect(page.getByRole('dialog', { name: 'Radix dialog' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Radix dialog' })).toBeHidden();
});
