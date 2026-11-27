import { readFile, writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  GJD_BINARY,
  requireDaemonBinary,
  stopDaemon,
  waitForDaemon,
  widgetRequests,
} from './support/daemon.js';
import { openSection } from './support/finetune.js';
import {
  FIXTURE_DIR,
  type FixtureServer,
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';

const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const APP = fixturePath('src/App.tsx');
const TOUCHED = [ORDER_BUTTON, APP];
const ORIGINAL_CLASS = 'rounded-lg bg-brand px-6 py-3 font-medium text-white';

let fixture: FixtureServer;
const originals = new Map<string, string>();

async function selectOrderButton(page: Page): Promise<{ button: Locator; panel: Locator }> {
  await openFixture(page, fixture.url);
  const select = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' });
  await select.click();
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return { button, panel };
}

async function applyAndUndo(page: Page, panel: Locator, file: string, written: string) {
  const before = originals.get(file) ?? '';
  expect(await readFile(file, 'utf8')).toBe(before);
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible();
  expect(await readFile(file, 'utf8')).toContain(written);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(file, 'utf8')).toBe(before);
}

async function dragBy(page: Page, handle: Locator, dx: number, dy: number, keys: string[] = []) {
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up();
  for (const key of keys) await page.keyboard.up(key);
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  for (const file of TOUCHED) originals.set(file, await readFile(file, 'utf8'));
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
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
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('typography edits preview live and write theme tokens', async ({ page }) => {
  const { button, panel } = await selectOrderButton(page);
  const text = await openSection(panel, 'Text');

  await text.getByLabel('Font size').fill('18');
  await text.getByRole('combobox', { name: 'Font weight' }).selectOption('700');
  await text.getByRole('button', { name: 'Align center' }).click();

  await expect(button).toHaveCSS('font-size', '18px');
  await expect(button).toHaveCSS('font-weight', '700');
  await panel.getByRole('tab', { name: 'Code' }).click();
  await expect(panel.getByRole('tabpanel', { name: 'Code' })).toContainText('text-lg');
  await applyAndUndo(page, panel, ORDER_BUTTON, 'font-bold');
  expect(originals.get(ORDER_BUTTON)).toContain(ORIGINAL_CLASS);
});

test('adds a stroke, a shadow preset and opacity without the AI', async ({ page }) => {
  const { button, panel } = await selectOrderButton(page);

  await panel
    .getByRole('region', { name: 'Stroke' })
    .getByRole('button', { name: 'Add stroke' })
    .click();
  await panel
    .getByRole('region', { name: 'Effects' })
    .getByRole('button', { name: 'Add effects' })
    .click();
  await (await openSection(panel, 'Opacity')).getByLabel('Element opacity').fill('50');

  await expect(button).toHaveCSS('border-top-width', '1px');
  await expect(button).toHaveCSS('opacity', '0.5');
  await expect(button).not.toHaveCSS('box-shadow', 'none');
  await panel.getByRole('tab', { name: 'Code' }).click();
  const code = panel.getByRole('tabpanel', { name: 'Code' });
  await expect(code).toContainText('border-black');
  await expect(code).toContainText('shadow-sm');
  await expect(code).toContainText('opacity-50');
  await applyAndUndo(page, panel, ORDER_BUTTON, 'opacity-50');
});

test('dragging a padding handle snaps to the spacing scale and shows the token', async ({
  page,
}) => {
  const { button, panel } = await selectOrderButton(page);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  await expect(bottom).toHaveAttribute('aria-valuetext', '12 · pb-3');

  await dragBy(page, bottom, 0, -9);

  await expect(button).toHaveCSS('padding-bottom', '20px');
  await expect(bottom).toHaveAttribute('aria-valuetext', '20 · pb-5');
  await applyAndUndo(page, panel, ORDER_BUTTON, 'px-6 pt-3 pb-5');
});

test('Shift drags in single pixels and Alt moves the opposite side too', async ({ page }) => {
  const { button, panel } = await selectOrderButton(page);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });

  await dragBy(page, bottom, 0, -5, ['Shift']);
  await expect(button).toHaveCSS('padding-bottom', '17px');
  await panel.getByRole('tab', { name: 'Code' }).click();
  await expect(panel.getByRole('tabpanel', { name: 'Code' })).toContainText('pb-[17px]');
  await panel.getByRole('button', { name: 'Revert' }).click();
  await expect(button).toHaveCSS('padding-bottom', '12px');

  await dragBy(page, bottom, 0, -9, ['Alt']);
  await expect(button).toHaveCSS('padding-top', '20px');
  await expect(button).toHaveCSS('padding-bottom', '20px');
  await applyAndUndo(page, panel, ORDER_BUTTON, 'px-6 py-5');
});

test('padding handles move with the arrow keys', async ({ page }) => {
  const { button, panel } = await selectOrderButton(page);
  const top = page.getByRole('slider', { name: 'Padding top' });

  await top.focus();
  await page.keyboard.press('ArrowUp');
  await expect(button).toHaveCSS('padding-top', '16px');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(top).toHaveAttribute('aria-valuetext', '17 · pt-[17px]');
  await page.keyboard.press('Shift+ArrowDown');
  await applyAndUndo(page, panel, ORDER_BUTTON, 'px-6 pt-4 pb-3');
});

test('a flex container offers a gap handle between its children', async ({ page }) => {
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  const nav = page.locator('nav').first();
  const links = nav.getByRole('link');
  const first = await links.nth(0).boundingBox();
  const second = await links.nth(1).boundingBox();
  if (!first || !second) throw new Error('nav links are not visible');
  await page.mouse.click((first.x + first.width + second.x) / 2, first.y + first.height / 2);
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  const gap = page.getByRole('slider', { name: 'Column gap' });
  await expect(gap).toHaveAttribute('aria-valuetext', '32 · gap-x-8');

  await gap.focus();
  await page.keyboard.press('ArrowDown');

  await expect(nav).toHaveCSS('column-gap', '28px');
  await applyAndUndo(page, panel, APP, 'flex gap-y-8 gap-x-7');
});
