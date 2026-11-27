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
const GIFT = 'Gift cards for every occasion';
const HEADLINE = 'Slow-roasted, made for mornings';
const ALREADY = 'Already matches the copied style.';

let fixture: FixtureServer;
const originals = new Map<string, string>();

function changedLines(file: string, written: string): number[] {
  const before = (originals.get(file) ?? '').split('\n');
  return written.split('\n').flatMap((line, index) => (line === before[index] ? [] : [index + 1]));
}

async function open(page: Page) {
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
}

async function copyFrom(page: Page, element: Locator, file: string) {
  await element.click();
  const panel = page.getByRole('dialog', { name: `Fine-tune ${file}` });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Copy style' }).click();
  const bar = page.getByRole('region', { name: 'Paste style' });
  await expect(bar).toBeVisible();
  return { panel, bar };
}

async function applyThenUndo(page: Page, panel: Locator, file: string) {
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible();
  const written = await readFile(file, 'utf8');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(file, 'utf8')).toBe(originals.get(file));
  return written;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  for (const file of [ORDER_BUTTON, APP]) originals.set(file, await readFile(file, 'utf8'));
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

test('with every group unticked, a click pastes nothing and does not claim a match', async ({
  page,
}) => {
  await open(page);
  const { bar } = await copyFrom(
    page,
    page.getByRole('button', { name: 'Order now' }),
    'src/components/OrderButton.tsx',
  );
  for (const box of await bar.getByRole('checkbox').all()) await box.uncheck();

  await page.getByRole('heading', { name: HEADLINE }).click();

  await expect(page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' })).toBeVisible();
  await expect(page.getByText('Unsaved')).toHaveCount(0);
  await expect(page.getByText(ALREADY)).toHaveCount(0);
  expect(await readFile(APP, 'utf8')).toBe(originals.get(APP));
});

test('pasting onto the element the style came from says it already matches', async ({ page }) => {
  await open(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await copyFrom(page, button, 'src/components/OrderButton.tsx');

  await button.click();

  await expect(page.getByText(ALREADY)).toBeVisible();
  await expect(page.getByText('Unsaved')).toHaveCount(0);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(originals.get(ORDER_BUTTON));
});

test('two quick clicks while pasting leave the draft on the last element only', async ({
  page,
}) => {
  await open(page);
  await copyFrom(
    page,
    page.getByRole('button', { name: 'Order now' }),
    'src/components/OrderButton.tsx',
  );
  const headline = page.getByRole('heading', { name: HEADLINE });
  const gift = page.getByText(GIFT);

  await Promise.all([headline.click(), gift.click()]);

  const panel = page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });
  await expect(panel.getByText('Unsaved')).toBeVisible();
  await expect(gift).toHaveCSS('padding-left', '24px');
  await expect
    .poll(() => headline.evaluate((element) => (element as HTMLElement).style.length))
    .toBe(0);
  const written = await applyThenUndo(page, panel, APP);
  expect(changedLines(APP, written)).toEqual([48]);
});

test('a second paste reverts the first element before drafting the second', async ({ page }) => {
  await open(page);
  await copyFrom(
    page,
    page.getByRole('button', { name: 'Order now' }),
    'src/components/OrderButton.tsx',
  );
  const headline = page.getByRole('heading', { name: HEADLINE });
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });

  await headline.click();
  await expect(panel.getByText('Unsaved')).toBeVisible();
  await expect(headline).toHaveCSS('background-color', 'rgb(190, 18, 60)');
  await page.getByText(GIFT).click();
  await expect(panel.getByText('Unsaved')).toBeVisible();

  await expect(headline).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const written = await applyThenUndo(page, panel, APP);
  expect(changedLines(APP, written)).toEqual([48]);
});

test('an inline-styled element pastes onto a Tailwind button as classes', async ({ page }) => {
  await open(page);
  await copyFrom(page, page.getByText(GIFT), 'src/App.tsx');
  const button = page.getByRole('button', { name: 'Order now' });
  await page
    .getByRole('dialog', { name: 'Fine-tune src/App.tsx' })
    .getByRole('button', { name: 'Close' })
    .click();
  await page.mouse.wheel(0, -5000);

  await button.click();

  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Unsaved')).toBeVisible();
  await expect(button).toHaveCSS('background-color', 'rgb(253, 230, 138)');
  await expect(button).toHaveCSS('padding-top', '16px');
  const written = await applyThenUndo(page, panel, ORDER_BUTTON);
  expect(written).not.toContain('style=');
  expect(written).toMatch(/\bp-4\b/);
  expect(written).toMatch(/bg-\[#fde68a\]/i);
});

test('copying an element with unsaved tweaks copies what is on screen', async ({ page }) => {
  await open(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const source = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(source.getByText('Reading the element…')).toHaveCount(0);
  await source.getByRole('region', { name: 'Text' }).getByLabel('Font size').fill('22');
  await expect(button).toHaveCSS('font-size', '22px');

  await source.getByRole('button', { name: 'Copy style' }).click();
  const headline = page.getByRole('heading', { name: HEADLINE });
  await headline.click();

  await expect(headline).toHaveCSS('font-size', '22px');
});

test('Alt+Shift+C typed into a panel field does not start copying', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Order now' }).click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);

  await panel.getByRole('region', { name: 'Text' }).getByLabel('Font size').focus();
  await page.keyboard.press('Alt+Shift+C');

  await expect(page.getByRole('region', { name: 'Paste style' })).toHaveCount(0);
});

test('after Stop a click selects the element without pasting', async ({ page }) => {
  await open(page);
  const { bar } = await copyFrom(
    page,
    page.getByRole('button', { name: 'Order now' }),
    'src/components/OrderButton.tsx',
  );

  await bar.getByRole('button', { name: 'Stop' }).click();
  await page.getByText(GIFT).click();

  const panel = page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  await expect(panel.getByText('Unsaved')).toHaveCount(0);
  await expect(page.getByText(GIFT)).toHaveCSS('background-color', 'rgb(253, 230, 138)');
});
