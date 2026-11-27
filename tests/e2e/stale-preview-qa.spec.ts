import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
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

let fixture: FixtureServer;
let original: string;

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
    line: 3,
    column: 5,
  });
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('an unsaved preview in a closed tab does not linger in a new tab', async ({ browser }) => {
  test.setTimeout(60_000);
  const first = await browser.newContext();
  const page = await first.newPage();
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  await page.getByRole('button', { name: 'Order now' }).click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await panel.getByRole('tab', { name: 'Code' }).click();
  await expect(panel.getByRole('tabpanel', { name: 'Code' })).toContainText('pb-5');
  await first.close();

  const second = await browser.newContext();
  const fresh = await second.newPage();
  await openFixture(fresh, fixture.url);

  await expect
    .poll(
      async () => {
        await fresh.reload();
        return fresh
          .getByRole('button', { name: 'Order now' })
          .evaluate((element) => getComputedStyle(element).paddingBottom);
      },
      { timeout: 15_000, intervals: [3_000] },
    )
    .toBe('12px');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  await second.close();
});

async function tweakWithoutApplying(page: import('@playwright/test').Page) {
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  await page.getByRole('button', { name: 'Order now' }).click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  await page.getByRole('slider', { name: 'Padding bottom' }).focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await panel.getByRole('tab', { name: 'Code' }).click();
  await expect(panel.getByRole('tabpanel', { name: 'Code' })).toContainText('pb-5');
}

function paddingBottom(page: import('@playwright/test').Page) {
  return page
    .getByRole('button', { name: 'Order now' })
    .evaluate((element) => getComputedStyle(element).paddingBottom);
}

test("an unsaved tweak doesn't outlive a reload of its own page", async ({ page }) => {
  test.setTimeout(60_000);
  await tweakWithoutApplying(page);

  await page.reload();
  const select = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' });
  if ((await select.getAttribute('aria-pressed')) !== 'true') await select.click();

  await expect.poll(() => paddingBottom(page), { timeout: 15_000 }).toBe('12px');
  await page.getByRole('button', { name: 'Order now' }).click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  await page.getByRole('slider', { name: 'Padding bottom' }).focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => paddingBottom(page)).toBe('16px');
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('pt-3 pb-4');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});

test('an unsaved tweak clears after a reload even when nothing is clicked', async ({ page }) => {
  test.setTimeout(60_000);
  await tweakWithoutApplying(page);

  await page.reload();

  await expect
    .poll(
      async () => {
        await page.reload();
        return paddingBottom(page);
      },
      { timeout: 20_000, intervals: [4_000] },
    )
    .toBe('12px');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});
