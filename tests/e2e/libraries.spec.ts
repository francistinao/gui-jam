import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const FAKE_PM_DIR = fileURLToPath(new URL('../fake-pm/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const MANIFEST = fixturePath('package.json');
const THREE = fixturePath('node_modules/three');
const BLUE = 'rgb(37, 99, 235)';
const DEEP_BLUE = 'rgb(29, 78, 216)';
const DIALOG = 'Ask AI src/components/OrderButton.tsx';

let fixture: FixtureServer;
let originalButton: string;
let originalManifest: string;
let workDir: string;
let cliLog: string;
let pmLog: string;
const savedPath = process.env.PATH;

interface CliRun {
  request?: string;
  libraries?: string | null;
  interrupted?: boolean;
}

async function lines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function circle(page: Page, element: Locator): Promise<void> {
  const box = await element.boundingBox();
  if (!box) throw new Error('the element is not visible');
  const left = box.x - 18;
  const right = box.x + box.width + 18;
  const top = box.y - 14;
  const bottom = box.y + box.height + 14;
  await page.mouse.move(left, top + 10);
  await page.mouse.down();
  for (const [x, y] of [
    [left + 30, top],
    [right, top + 6],
    [right - 4, bottom],
    [left + 6, bottom - 2],
    [left, top + 14],
  ] as const) {
    await page.mouse.move(x, y, { steps: 6 });
  }
  await page.mouse.up();
}

async function askFor(page: Page, request: string): Promise<Locator> {
  await openFixture(page, fixture.url);
  await page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' }).click();
  await circle(page, page.getByRole('button', { name: 'Order now' }));
  const prompt = page.getByRole('dialog', { name: DIALOG });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  return prompt;
}

function tilesOf(dialog: Locator): Locator {
  return dialog.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  workDir = await mkdtemp(join(tmpdir(), 'guijam-libraries-'));
  cliLog = join(workDir, 'runs.jsonl');
  pmLog = join(workDir, 'pm.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.GUIJAM_FAKE_PM_LOG = pmLog;
  process.env.PATH = `${FAKE_PM_DIR}:${FAKE_CLI_DIR}:${savedPath ?? ''}`;
  originalManifest = await readFile(MANIFEST, 'utf8');
  await rm(THREE, { recursive: true, force: true });
  fixture = await startFixtureServer();
  originalButton = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== originalButton) {
    await writeFile(ORDER_BUTTON, originalButton);
  }
  if ((await readFile(MANIFEST, 'utf8')) !== originalManifest) {
    await writeFile(MANIFEST, originalManifest);
  }
  await rm(THREE, { recursive: true, force: true });
  await rm(`${pmLog}.fail`, { force: true });
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
  for (const name of ['GUIJAM_GJD_BIN', 'GUIJAM_FAKE_CLAUDE_LOG', 'GUIJAM_FAKE_PM_LOG']) {
    delete process.env[name];
  }
  process.env.PATH = savedPath;
  await rm(workDir, { recursive: true, force: true });
});

test('a variant that needs three waits for Install and preview, then previews it', async ({
  page,
}) => {
  const request = 'Make it 3d';
  const prompt = await askFor(page, request);
  const button = page.getByRole('button', { name: /^Order now/ });
  const variants = prompt.getByRole('region', { name: 'Variants' });

  await expect(tilesOf(prompt)).toHaveText(['V1Css', 'V2Scene']);
  await expect(variants).toContainText(
    "1 variant was dropped: It imports left-pad-pro, which isn't installed.",
  );
  await expect(button).toHaveCSS('background-color', DEEP_BLUE);
  expect((await lines<CliRun>(cliLog)).find((run) => run.request === request)?.libraries).toBe('');

  await tilesOf(prompt).nth(1).click();

  const needs = variants.getByRole('region', { name: 'Needs libraries' });
  await expect(needs).toContainText(
    "Needs three 0.187.0. It isn't previewed until you install it.",
  );
  await expect(needs).toContainText('pnpm add --save-exact three@0.187.0');
  await expect(variants.getByRole('button', { name: 'Use V2' })).toBeDisabled();
  await expect(button).not.toHaveCSS('background-color', DEEP_BLUE);
  expect(await lines(pmLog)).toEqual([]);

  await needs.getByRole('button', { name: 'Install and preview' }).click();

  await expect(page.getByRole('button', { name: 'Order now · r187' })).toBeVisible({
    timeout: 30_000,
  });
  const dialog = page.getByRole('dialog', { name: DIALOG });
  await expect(dialog.getByRole('button', { name: 'V2 · Scene' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByRole('region', { name: 'Needs libraries' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Use V2' })).toBeEnabled();
  expect(await lines(pmLog)).toEqual([
    { cwd: resolve(FIXTURE_DIR), args: ['add', '--save-exact', 'three@0.187.0'] },
  ]);
  expect(JSON.parse(await readFile(MANIFEST, 'utf8')).dependencies.three).toBe('0.187.0');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(originalButton);

  await dialog
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(page.getByRole('button', { name: 'Order now', exact: true })).toBeVisible();
});

test('a failed install says why and leaves the variant waiting', async ({ page }) => {
  await writeFile(`${pmLog}.fail`, '');
  const prompt = await askFor(page, 'Make it 3d again');
  await tilesOf(prompt).nth(1).click();
  const needs = prompt.getByRole('region', { name: 'Needs libraries' });

  await needs.getByRole('button', { name: 'Install and preview' }).click();

  await expect(needs.getByRole('alert')).toContainText(
    'pnpm add --save-exact three@0.187.0 failed: ',
  );
  await expect(needs.getByRole('alert')).toContainText('ERR_PNPM_FETCH_404');
  await expect(needs.getByRole('alert')).toContainText(
    'Install it yourself, then pick the variant again.',
  );
  await expect(needs.getByRole('button', { name: 'Install and preview' })).toBeEnabled();
  await expect(prompt.getByRole('button', { name: 'Use V2' })).toBeDisabled();
  expect(await readFile(MANIFEST, 'utf8')).toBe(originalManifest);
  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
});

test('a drawing still generating survives a page reload and its variants land', async ({
  page,
}) => {
  const request = 'Make it feel more premium, linger';
  const prompt = await askFor(page, request);
  await expect(prompt.getByRole('list', { name: 'Progress' })).toBeVisible();

  await page.reload();

  const dialog = page.getByRole('dialog', { name: DIALOG });
  await expect(dialog.getByRole('list', { name: 'Progress' })).toBeVisible();
  await expect(tilesOf(dialog)).toHaveText(['V1Solid', 'V2Deep', 'V3Outline'], {
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS('background-color', BLUE);
  expect((await lines<CliRun>(cliLog)).some((run) => run.interrupted)).toBe(false);

  await dialog
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
});

test('a ready drawing comes back with its variants and preview after a reload', async ({
  page,
}) => {
  const prompt = await askFor(page, 'Make it feel more premium');
  await expect(tilesOf(prompt)).toHaveText(['V1Solid', 'V2Deep', 'V3Outline']);
  const button = page.getByRole('button', { name: 'Order now' });
  await expect(button).toHaveCSS('background-color', BLUE);

  await page.reload();

  const dialog = page.getByRole('dialog', { name: DIALOG });
  await expect(tilesOf(dialog)).toHaveText(['V1Solid', 'V2Deep', 'V3Outline']);
  await expect(button).toHaveCSS('background-color', BLUE);
  await tilesOf(dialog).nth(2).click();
  await expect(button).toHaveCSS('border-top-width', '2px');
  await dialog
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(button).not.toHaveCSS('border-top-width', '2px');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(originalButton);
});
