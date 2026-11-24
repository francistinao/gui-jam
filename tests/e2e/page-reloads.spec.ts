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
import { searchPath } from './support/process.js';
import { drawStroke } from './support/strokes.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const APP_FILE = 'src/App.tsx';
const READY_MS = 20_000;
const SETTLE_MS = 8_000;

let fixture: FixtureServer;
let original: string;
let originalApp: string;
const savedEnv = { PATH: process.env.PATH };

function orderButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Order now' });
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

async function drawAndAsk(page: Page, request: string): Promise<Locator> {
  await openFixture(page, fixture.url);
  const draw = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  await circle(page, orderButton(page));
  const prompt = page.getByRole('dialog', { name: `Ask AI ${ORDER_BUTTON_FILE}` });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  return prompt;
}

function countLoads(page: Page): () => number {
  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });
  return () => loads;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  original = await readFile(fixturePath(ORDER_BUTTON_FILE), 'utf8');
  originalApp = await readFile(fixturePath(APP_FILE), 'utf8');
  await writeFile(
    fixturePath(ORDER_BUTTON_FILE),
    `${original}\nexport const ORDER_SAMPLES = ['Order now'];\n`,
  );
  await writeFile(fixturePath(APP_FILE), `${originalApp}\nexport const APP_LINKS = ['Menu'];\n`);
  fixture = await startFixtureServer();
  await waitForDaemon(widgetRequests(fixture.api), { file: ORDER_BUTTON_FILE, line: 3, column: 5 });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
});

test.afterAll(async () => {
  await writeFile(fixturePath(ORDER_BUTTON_FILE), original);
  await writeFile(fixturePath(APP_FILE), originalApp);
  delete process.env.GUIJAM_GJD_BIN;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('picking variants of a file that hot reload cannot swap reloads the page once per pick and settles', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const prompt = await drawAndAsk(page, 'Make it blue with a soft shadow');
  const loads = countLoads(page);

  await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
    timeout: READY_MS,
  });
  await page.waitForTimeout(SETTLE_MS);

  expect(loads()).toBeLessThanOrEqual(1);
  const tiles = prompt.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
  await expect(tiles).toHaveText(['V1Solid', 'V2Deep', 'V3Outline']);
  await expect(orderButton(page)).toHaveCSS('background-color', 'rgb(37, 99, 235)');

  await tiles.nth(1).click();

  await expect(orderButton(page)).toHaveCSS('background-color', 'rgb(29, 78, 216)');
  await page.waitForTimeout(SETTLE_MS);
  expect(loads()).toBeLessThanOrEqual(2);
  await expect(tiles.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(orderButton(page)).toHaveCSS('background-color', 'rgb(29, 78, 216)');
  await prompt.getByRole('button', { name: 'Discard' }).click();
  await page.waitForTimeout(SETTLE_MS);
  expect(loads()).toBeLessThanOrEqual(3);
  await expect(orderButton(page)).toHaveCSS('background-color', 'rgb(190, 18, 60)');
});

test('a pill clicked on another page while its drawing generates loads its page once and settles', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const prompt = await drawAndAsk(page, 'Make it blue with a soft shadow, linger');
  await expect(page.getByRole('button', { name: /^Drawing 1: Generating/ })).toBeVisible();
  await page.goto(new URL('login', fixture.url).href);
  const away = page.getByRole('button', { name: /^Drawing 1: Generating\. Opens \/$/ });
  await expect(away).toBeVisible();
  const loads = countLoads(page);

  await away.click();

  await expect(page).toHaveURL(fixture.url);
  await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
    timeout: READY_MS,
  });
  await page.waitForTimeout(SETTLE_MS);
  expect(loads()).toBeLessThanOrEqual(2);
  await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
});

test('a pill clicked on another page after its variants arrived loads its page once and settles', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const prompt = await drawAndAsk(page, 'Make it blue with a soft shadow');
  await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
    timeout: READY_MS,
  });
  await page.goto(new URL('login', fixture.url).href);
  const away = page.getByRole('button', { name: /^Drawing 1: \d variants?\. Opens \/$/ });
  await expect(away).toBeVisible();
  const loads = countLoads(page);

  await away.click();

  await expect(page).toHaveURL(fixture.url);
  await page.waitForTimeout(SETTLE_MS);
  expect(loads()).toBeLessThanOrEqual(2);
  await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
});
