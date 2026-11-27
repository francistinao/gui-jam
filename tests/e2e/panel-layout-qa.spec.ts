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
const BUTTON_PANEL = 'Fine-tune src/components/OrderButton.tsx';
const GIFT = 'Gift cards for every occasion';
const EDITABLE = ['Layout', 'Radius', 'Fill', 'Text', 'Opacity'];

let fixture: FixtureServer;
const originals = new Map<string, string>();

async function select(page: Page, element: Locator, panelName: string) {
  await element.click();
  const panel = page.getByRole('dialog', { name: panelName });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
}

async function selectButton(page: Page) {
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  return select(page, page.getByRole('button', { name: 'Order now' }), BUTTON_PANEL);
}

function details(panel: Locator, name: string) {
  return panel.getByRole('region', { name, exact: true }).locator('details');
}

function summary(panel: Locator, name: string) {
  return panel.getByRole('region', { name, exact: true }).locator('summary');
}

async function sectionsHeight(panel: Locator): Promise<number> {
  return panel.evaluate((element) =>
    [...element.querySelectorAll('section[aria-label]')]
      .filter((section) => section.getAttribute('aria-label') !== 'Content')
      .reduce((total, section) => total + section.getBoundingClientRect().height, 0),
  );
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

test('Ask AI leads the panel above Sketch, and the header has no other Ask AI', async ({
  page,
}) => {
  const panel = await selectButton(page);
  const ask = panel.getByRole('button', { name: 'Ask AI' });
  const sketch = panel.getByRole('button', { name: 'Sketch what you want for this component' });

  await expect(ask).toHaveCount(1);
  const [askBox, sketchBox] = [await ask.boundingBox(), await sketch.boundingBox()];
  expect(askBox?.y ?? 0).toBeLessThan(sketchBox?.y ?? 0);
  expect(askBox?.width ?? 0).toBeGreaterThanOrEqual((sketchBox?.width ?? 0) - 1);
  await ask.click();

  await expect(
    page
      .getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' })
      .getByRole('textbox', { name: 'Describe the change' }),
  ).toBeVisible();
});

test('every style section starts closed and names its value', async ({ page }) => {
  const panel = await selectButton(page);

  for (const name of EDITABLE) await expect(details(panel, name)).not.toHaveAttribute('open');
  await expect(summary(panel, 'Layout')).toContainText('12 24 12 24');
  await expect(summary(panel, 'Fill')).toContainText('brand');
  await expect(summary(panel, 'Opacity')).toContainText('100%');
  await expect(summary(panel, 'Text')).toContainText('Medium');
  await expect(
    panel
      .getByRole('region', { name: 'Stroke', exact: true })
      .getByRole('button', { name: 'Add stroke' }),
  ).toBeVisible();
  await expect(
    panel.getByText('Shift+click to add more components to one Ask AI prompt.'),
  ).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Code' })).toBeVisible();
});

test('the panel stays short until sections are opened', async ({ page }) => {
  const panel = await selectButton(page);
  const closed = await sectionsHeight(panel);
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();

  for (const name of EDITABLE) await openSection(panel, name);

  expect(closed).toBeLessThan((await sectionsHeight(panel)) * 0.5);
  expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThan((viewport?.height ?? 0) - 24);
});

test('Enter and Space on a section header open and close it', async ({ page }) => {
  const panel = await selectButton(page);

  await summary(panel, 'Fill').focus();
  await page.keyboard.press('Enter');
  await expect(details(panel, 'Fill')).toHaveAttribute('open');
  await page.keyboard.press('Space');
  await expect(details(panel, 'Fill')).not.toHaveAttribute('open');
});

test('an opened section stays open on the next element and after a reload', async ({ page }) => {
  const panel = await selectButton(page);
  await openSection(panel, 'Text');

  const gift = await select(page, page.getByText(GIFT), 'Fine-tune src/App.tsx');
  await expect(details(gift, 'Text')).toHaveAttribute('open');
  await expect(details(gift, 'Fill')).not.toHaveAttribute('open');

  const again = await selectButton(page);
  await expect(details(again, 'Text')).toHaveAttribute('open');
});

test('a padding drag updates the closed Layout header and marks it edited', async ({ page }) => {
  const panel = await selectButton(page);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });

  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');

  await expect(details(panel, 'Layout')).not.toHaveAttribute('open');
  await expect(summary(panel, 'Layout')).toContainText('12 24 20 24');
  await expect(summary(panel, 'Layout')).toContainText('Edited');
  await expect(summary(panel, 'Fill')).not.toContainText('Edited');
  await panel.getByRole('button', { name: 'Revert' }).click();
});

test('a pasted style shows up in the closed headers of the target', async ({ page }) => {
  const panel = await selectButton(page);
  await panel.getByRole('button', { name: 'Copy style' }).click();

  const gift = await select(page, page.getByText(GIFT), 'Fine-tune src/App.tsx');

  await expect(summary(gift, 'Fill')).toContainText('brand');
  await expect(summary(gift, 'Fill')).toContainText('Edited');
  await expect(details(gift, 'Fill')).not.toHaveAttribute('open');
  await gift.getByRole('button', { name: 'Revert' }).click();
});

test('adding a stroke opens its section with the stroke fields', async ({ page }) => {
  const panel = await selectButton(page);

  await panel
    .getByRole('region', { name: 'Stroke', exact: true })
    .getByRole('button', { name: 'Add stroke' })
    .click();

  await expect(details(panel, 'Stroke')).toHaveAttribute('open');
  await expect(
    panel.getByRole('region', { name: 'Stroke', exact: true }).getByLabel('Stroke width'),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Revert' }).click();
});

test('Apply and Revert work with every section closed, and the Code tab shows the change', async ({
  page,
}) => {
  const panel = await selectButton(page);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await panel.getByRole('tab', { name: 'Code' }).click();
  await expect(panel.getByRole('tabpanel', { name: 'Code' })).toContainText('pb-4');
  await panel.getByRole('tab', { name: 'Design' }).click();

  await panel.getByRole('button', { name: 'Revert' }).click();
  await expect(summary(panel, 'Layout')).not.toContainText('Edited');
  await expect(summary(panel, 'Layout')).toContainText('12 24 12 24');

  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/Applied to/)).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('pb-4');
});

test('a corrupt remembered state still opens a usable panel', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('guijam:sections', '{"layout": [1, 2');
    } catch {}
  });

  const panel = await selectButton(page);

  for (const name of EDITABLE) await expect(details(panel, name)).not.toHaveAttribute('open');
  await openSection(panel, 'Fill');
  await expect(details(panel, 'Fill')).toHaveAttribute('open');
});
