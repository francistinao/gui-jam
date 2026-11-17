import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const APP = fixturePath('src/App.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const READY_MS = 20_000;

let fixture: FixtureServer;
let originalApp: string;
let cliLog: string;
const savedEnv = { PATH: process.env.PATH };

interface CliRun {
  request?: string;
}

async function cliRuns(): Promise<CliRun[]> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
}

async function startDrawing(page: Page): Promise<{ left: number; top: number }> {
  await openFixture(page, fixture.url);
  const tool = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  const anchor = await page.getByRole('button', { name: 'Order now' }).boundingBox();
  if (!anchor) throw new Error('the button is not visible');
  return { left: anchor.x + 520, top: anchor.y - 12 };
}

async function stroke(page: Page, points: readonly (readonly [number, number])[]): Promise<void> {
  const [first, ...rest] = points;
  if (!first) return;
  await page.mouse.move(first[0], first[1]);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

async function box(page: Page, left: number, top: number, width = 110, height = 60): Promise<void> {
  await stroke(page, [
    [left, top + height],
    [left, top],
    [left + width, top],
    [left + width, top + height],
    [left + 4, top + height - 2],
  ]);
}

async function generate(dialog: Locator, request: string): Promise<void> {
  await dialog.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await dialog.getByRole('button', { name: 'Generate' }).click();
}

function badge(page: Page, name: string | RegExp): Locator {
  return page.getByRole('button', { name });
}

async function discardAll(page: Page): Promise<void> {
  const badges = badge(page, /^Drawing \d/);
  for (let left = await badges.count(); left > 0; left -= 1) {
    await badges.first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^(Discard|Clear sketch)$/ })
      .click();
    await expect(badges).toHaveCount(left - 1);
  }
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  cliLog = join(await mkdtemp(join(tmpdir(), 'guijam-fake-claude-')), 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  originalApp = await readFile(APP, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async () => {
  if ((await readFile(APP, 'utf8')) !== originalApp) await writeFile(APP, originalApp);
  await rm(fixturePath('src/assets'), { recursive: true, force: true });
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('a stray stroke while a drawing generates opens a draft that Escape removes', async ({
  page,
}) => {
  const { left, top } = await startDrawing(page);
  await box(page, left, top, 260, 72);
  const dialog = page.getByRole('dialog');
  await generate(dialog, 'a card like this, linger');
  await expect(badge(page, 'Drawing 1: Generating')).toBeVisible();

  await stroke(page, [
    [left, top + 150],
    [left + 140, top + 160],
  ]);
  await expect(dialog.getByRole('img', { name: 'Drawing 2' })).toBeVisible();
  await expect(badge(page, 'Drawing 2: Draft')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(badge(page, /^Drawing 2/)).toHaveCount(0);
  await expect(dialog.getByRole('img', { name: 'Drawing 1' })).toBeVisible();
  await expect(badge(page, 'Drawing 1: 1 variant')).toBeVisible({ timeout: READY_MS });
  await expect(page.getByRole('main').getByText('Sketched card', { exact: true })).toBeVisible();
  const code = dialog.getByRole('region', { name: 'Code changes' });
  await expect(code).toHaveCSS('max-height', '160px');
  await expect(code).toHaveCSS('overflow-y', 'auto');
  const panel = await dialog.boundingBox();
  expect(panel && panel.y + panel.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
  expect((await cliRuns()).filter((run) => run.request?.includes('linger'))).toHaveLength(1);

  await discardAll(page);
});

test('three drawings generate at once and a fourth is refused', async ({ page }) => {
  const { left, top } = await startDrawing(page);
  const requests = ['a cup card, linger', 'a star card, linger', 'a leaf card, linger'];
  for (const [index, request] of requests.entries()) {
    await box(page, left + index * 160, top);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('img', { name: `Drawing ${index + 1}` })).toBeVisible();
    await generate(dialog, request);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  await expect
    .poll(
      async () => (await cliRuns()).filter((run) => run.request?.endsWith('card, linger')).length,
    )
    .toBe(3);
  await expect(badge(page, /: Generating$/)).toHaveCount(3);

  await box(page, left, top + 110);

  await expect(
    page.getByRole('status').filter({ hasText: 'Up to 3 drawings at a time.' }),
  ).toBeVisible();
  await expect(badge(page, /^Drawing \d/)).toHaveCount(3);
  for (const number of [1, 2, 3]) {
    await expect(badge(page, `Drawing ${number}: 1 variant`)).toBeVisible({ timeout: READY_MS });
  }

  await discardAll(page);
});

test('only one drawing previews at a time, and a later one is rebased onto an applied one', async ({
  page,
}) => {
  const { left, top } = await startDrawing(page);
  await box(page, left, top);
  await generate(page.getByRole('dialog'), 'a cup card, pause');
  await page.keyboard.press('Escape');
  await box(page, left + 160, top);
  await generate(page.getByRole('dialog'), 'a star card, pause');
  await page.keyboard.press('Escape');
  const main = page.getByRole('main');
  const cupCard = main.getByText('Sketched card', { exact: true });
  const starCard = main.getByText('Sketched star card', { exact: true });
  await expect(badge(page, 'Drawing 1: 1 variant')).toBeVisible({ timeout: READY_MS });
  await expect(badge(page, 'Drawing 2: 1 variant')).toBeVisible({ timeout: READY_MS });
  await expect(cupCard).toBeVisible();
  await expect(starCard).toHaveCount(0);

  await badge(page, 'Drawing 2: 1 variant').click();

  await expect(starCard).toBeVisible();
  await expect(cupCard).toHaveCount(0);

  await page.getByRole('dialog').getByRole('button', { name: 'Use V1' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' })).toBeVisible();
  const afterStar = await readFile(APP, 'utf8');
  expect(afterStar).toContain("import starIcon from './assets/icons/star-icon.svg';");
  expect(afterStar).not.toContain('cupIcon');

  await badge(page, 'Drawing 1: 1 variant').click();

  await expect(cupCard).toBeVisible();
  await expect(starCard).toBeVisible();

  await page.getByRole('dialog').getByRole('button', { name: 'Use V1' }).click();

  await expect(badge(page, /^Drawing \d/)).toHaveCount(0);
  const toast = page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' });
  await expect(toast).toBeVisible();
  const both = await readFile(APP, 'utf8');
  expect(both).toContain("import cupIcon from './assets/icons/cup-icon.svg';");
  expect(both).toContain("import starIcon from './assets/icons/star-icon.svg';");
  await expect(badge(page, /^Drawing \d/)).toHaveCount(0);

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(APP, 'utf8')).toBe(afterStar);
});
