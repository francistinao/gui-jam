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
  replaceOnce,
  startFixtureServer,
} from './support/fixture.js';

const APP = fixturePath('src/App.tsx');
const GIFT = 'Gift cards for every occasion';
const HEADING = 'Slow-roasted, made for mornings';
const RUN = Date.now().toString(36);

let fixture: FixtureServer;
let original: string;

function toolbar(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'GUIJam' });
}

function history(page: Page): Locator {
  return page.getByRole('dialog', { name: 'History' });
}

function row(page: Page, title: RegExp | string): Locator {
  return history(page).getByRole('listitem', { name: title });
}

async function open(page: Page, name: string): Promise<void> {
  await openFixture(page, `${fixture.url}?history=${name}-${RUN}`);
}

async function apply(page: Page, target: Locator, change: (panel: Locator) => Promise<void>) {
  const select = toolbar(page).getByRole('button', { name: 'Select' });
  if ((await select.getAttribute('aria-pressed')) !== 'true') await select.click();
  await target.click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  await change(panel);
  await expect(panel.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close' }).click();
}

async function fill(panel: Locator, hex: string): Promise<void> {
  await panel.getByRole('textbox', { name: 'Fill hex' }).fill(hex);
}

async function openHistory(page: Page): Promise<void> {
  await toolbar(page).getByRole('button', { name: 'History' }).click();
  await expect(history(page)).toBeVisible();
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  original = await readFile(APP, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
    line: 3,
    column: 5,
  });
});

test.afterEach(async () => {
  if ((await readFile(APP, 'utf8')) !== original) await writeFile(APP, original);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('undoes an older change and keeps a later one in the same file', async ({ page }) => {
  await open(page, 'older');
  await apply(page, page.getByText(GIFT), (panel) => fill(panel, '1d4ed8'));
  const afterGift = await readFile(APP, 'utf8');
  await apply(page, page.getByRole('heading', { name: HEADING }), (panel) =>
    panel.getByRole('region', { name: 'Text' }).getByLabel('Font size').fill('40'),
  );

  await openHistory(page);
  await expect(history(page).getByRole('listitem')).toHaveCount(2);
  const gift = row(page, 'App · Fill #1D4ED8, src/App.tsx');
  await gift.getByRole('button', { name: 'Undo' }).click();

  await expect(gift.getByRole('button', { name: 'Redo' })).toBeVisible();
  await expect(gift).toContainText('Undone');
  const written = await readFile(APP, 'utf8');
  expect(written).toContain("backgroundColor: '#fde68a'");
  expect(written).not.toBe(original);
  expect(written).not.toBe(afterGift);
  await expect(page.getByText(GIFT)).toHaveCSS('background-color', 'rgb(253, 230, 138)');
});

test('an edit made in the editor elsewhere in the file stays after undo', async ({ page }) => {
  await open(page, 'editor');
  await apply(page, page.getByText(GIFT), (panel) => fill(panel, '1d4ed8'));
  const edited = replaceOnce(await readFile(APP, 'utf8'), 'Today’s menu', 'Today’s specials');
  await writeFile(APP, edited);

  await openHistory(page);
  await row(page, /Fill #1D4ED8/)
    .getByRole('button', { name: 'Undo' })
    .click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  const written = await readFile(APP, 'utf8');
  expect(written).toContain('Today’s specials');
  expect(written).toBe(replaceOnce(original, 'Today’s menu', 'Today’s specials'));
});

test('a change that a later one built on names the later one and writes nothing', async ({
  page,
}) => {
  await open(page, 'conflict');
  await apply(page, page.getByText(GIFT), (panel) => fill(panel, '1d4ed8'));
  await apply(page, page.getByText(GIFT), (panel) => fill(panel, '15803d'));
  const before = await readFile(APP, 'utf8');

  await openHistory(page);
  await row(page, /Fill #1D4ED8/)
    .getByRole('button', { name: 'Undo' })
    .click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText("Undo 'App · Fill #15803D' first.");
  expect(await readFile(APP, 'utf8')).toBe(before);
  await row(page, /Fill #15803D/)
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(row(page, /Fill #15803D/).getByRole('button', { name: 'Redo' })).toBeVisible();
  await row(page, /Fill #1D4ED8/)
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect.poll(() => readFile(APP, 'utf8')).toBe(original);
});

test('redo reapplies a change and undo works again after it', async ({ page }) => {
  await open(page, 'redo');
  await apply(page, page.getByText(GIFT), (panel) => fill(panel, '1d4ed8'));
  const applied = await readFile(APP, 'utf8');
  await openHistory(page);
  const gift = row(page, /Fill #1D4ED8/);

  await gift.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(APP, 'utf8')).toBe(original);
  await gift.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Change reapplied.' })).toBeVisible();
  await expect.poll(() => readFile(APP, 'utf8')).toBe(applied);
  await gift.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(APP, 'utf8')).toBe(original);
});

test('This page lists only its own changes, and a change elsewhere opens its page', async ({
  page,
}) => {
  await open(page, 'first');
  await apply(page, page.getByText(GIFT), (panel) => fill(panel, '1d4ed8'));
  await open(page, 'second');

  await openHistory(page);
  await expect(history(page)).toContainText('Nothing applied on this page yet.');
  await history(page).getByRole('tab', { name: 'All pages' }).click();
  const elsewhere = history(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: `Opens /?history=first-${RUN} ↗` }) });
  await elsewhere.getByRole('button', { name: `Opens /?history=first-${RUN} ↗` }).click();

  await expect(page).toHaveURL(new RegExp(`\\?history=first-${RUN}$`));
  await expect(history(page)).toBeVisible();
  await expect(row(page, /Fill #1D4ED8/)).toHaveCount(1);
});

test('History survives a reload, toggles with Alt+Shift+H and closes with Esc', async ({
  page,
}) => {
  await open(page, 'reload');
  await apply(page, page.getByText(GIFT), (panel) => fill(panel, '1d4ed8'));
  await page.reload();

  await page.keyboard.press('Alt+Shift+H');
  await expect(history(page)).toBeVisible();
  await expect(row(page, /Fill #1D4ED8/)).toHaveCount(1);
  await expect(toolbar(page).getByRole('button', { name: 'History' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(history(page)).toHaveCount(0);
});
