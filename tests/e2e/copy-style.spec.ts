import { readFile, writeFile } from 'node:fs/promises';
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

const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const APP = fixturePath('src/App.tsx');
const TOUCHED = [ORDER_BUTTON, APP];

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

const GIFT = 'Gift cards for every occasion';
const BRAND_RGB = 'rgb(190, 18, 60)';
const GIFT_RGB = 'rgb(253, 230, 138)';

function giftPanel(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });
}

test('copies a button style and pastes it onto an inline-styled paragraph', async ({ page }) => {
  const { panel } = await selectOrderButton(page);
  await panel.getByRole('button', { name: 'Copy style' }).click();
  const bar = page.getByRole('region', { name: 'Paste style' });
  await expect(bar).toContainText('Pasting style from button in OrderButton.tsx');
  await expect(bar.getByRole('checkbox', { name: 'Fill' })).toBeChecked();

  const gift = page.getByText(GIFT);
  await gift.click();

  const target = giftPanel(page);
  await expect(target.getByText('Unsaved')).toBeVisible();
  await expect(gift).toHaveCSS('background-color', BRAND_RGB);
  await expect(gift).toHaveCSS('padding-left', '24px');
  expect(await readFile(APP, 'utf8')).toBe(originals.get(APP));
  await target.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' });
  await expect(toast).toBeVisible();
  const written = await readFile(APP, 'utf8');
  expect(written).toContain("backgroundColor: 'var(--color-brand, #BE123C)'");
  expect(written).toContain("padding: '12px 24px'");
  expect(written).not.toContain('borderRadius: 8, borderRadius');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(APP, 'utf8')).toBe(originals.get(APP));
  await expect(bar).toBeVisible();
});

test('unticked groups are not pasted, and Shift+click pastes instead of grouping', async ({
  page,
}) => {
  const { panel } = await selectOrderButton(page);
  await panel.getByRole('button', { name: 'Copy style' }).click();
  const bar = page.getByRole('region', { name: 'Paste style' });
  await bar.getByRole('checkbox', { name: 'Fill' }).uncheck();

  const gift = page.getByText(GIFT);
  await gift.click({ modifiers: ['Shift'] });

  await expect(giftPanel(page).getByText('Unsaved')).toBeVisible();
  await expect(gift).toHaveCSS('padding-left', '24px');
  await expect(gift).toHaveCSS('background-color', GIFT_RGB);
  await expect(page.getByRole('dialog', { name: /^Prompt/ })).toHaveCount(0);
});

test('Esc stops pasting and keeps the pasted draft, then closes the panel', async ({ page }) => {
  const { panel } = await selectOrderButton(page);
  await panel.getByRole('button', { name: 'Copy style' }).click();
  const gift = page.getByText(GIFT);
  await gift.click();
  const target = giftPanel(page);
  await expect(target.getByText('Unsaved')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByRole('region', { name: 'Paste style' })).toHaveCount(0);
  await expect(target.getByText('Unsaved')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(target).toHaveCount(0);
  await expect(gift).toHaveCSS('background-color', GIFT_RGB);
});

test('Alt+Shift+C copies, and the paste bar survives a reload', async ({ page }) => {
  await selectOrderButton(page);
  await page.keyboard.press('Alt+Shift+C');
  const bar = page.getByRole('region', { name: 'Paste style' });
  await expect(bar).toBeVisible();

  await page.reload();

  await expect(bar).toContainText('Pasting style from button in OrderButton.tsx');
  await expect(
    page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Select' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByText(GIFT).click();
  await expect(page.getByText(GIFT)).toHaveCSS('background-color', BRAND_RGB);
  await bar.getByRole('button', { name: 'Stop' }).click();
  await expect(bar).toHaveCount(0);
});
