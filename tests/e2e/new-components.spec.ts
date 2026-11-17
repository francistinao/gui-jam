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

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const LEVELS = ['atoms', 'molecules', 'organisms'];
const PRICE = fixturePath('src/components/atoms/Price.tsx');
const PLAN_CARD = fixturePath('src/components/molecules/PlanCard.tsx');
const PRICING = fixturePath('src/components/organisms/PricingSection.tsx');
const OUTSIDE = fixturePath('src/pages/Pricing.tsx');

let fixture: FixtureServer;
let original: string;
let workDir: string;
let cliLog: string;
const savedPath = process.env.PATH;

interface CliRun {
  request?: string;
  newUi?: string | null;
}

async function cliRuns(): Promise<CliRun[]> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
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
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  return prompt;
}

async function removeCreated(): Promise<void> {
  for (const level of LEVELS) {
    await rm(fixturePath(`src/components/${level}`), { recursive: true, force: true });
  }
  await rm(fixturePath('src/pages'), { recursive: true, force: true });
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  workDir = await mkdtemp(join(tmpdir(), 'guijam-components-'));
  cliLog = join(workDir, 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = `${FAKE_CLI_DIR}:${savedPath ?? ''}`;
  await removeCreated();
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
  await removeCreated();
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedPath;
  await rm(workDir, { recursive: true, force: true });
});

test('a new section is split into atoms, molecules and an organism that preview, write on Use and leave on Undo', async ({
  page,
}) => {
  const request = 'Add a pricing section with two plans';
  const prompt = await askFor(page, request);

  const variants = prompt.getByRole('region', { name: 'Variants' });
  const tiles = variants.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
  await expect(tiles).toHaveText(['V1Split', 'V2Inline']);
  await expect(variants).toContainText(
    '1 variant was dropped: It creates src/pages/Pricing.tsx, outside src/components/.',
  );
  const pricing = page.getByRole('main').getByRole('region', { name: 'Pricing' });
  await expect(pricing).toContainText('Starter$9');
  await expect(pricing).toContainText('Pro$19');
  await expect(variants).toContainText('Price.tsx, PlanCard.tsx, PricingSection.tsx');
  const files = variants.locator('[data-change-file]');
  await expect(files).toContainText([
    'src/components/OrderButton.tsx',
    'src/components/atoms/Price.tsx',
    'src/components/molecules/PlanCard.tsx',
    'src/components/organisms/PricingSection.tsx',
  ]);
  for (const path of [PRICE, PLAN_CARD, PRICING, OUTSIDE]) expect(await exists(path)).toBe(false);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  expect((await cliRuns()).find((run) => run.request === request)?.newUi).toBe('src/components');

  await tiles.nth(1).click();
  await expect(page.getByRole('button', { name: 'Order now · from $9' })).toBeVisible();
  await expect(pricing).toHaveCount(0);
  await tiles.nth(0).click();
  await expect(pricing).toContainText('Pro$19');

  await variants.getByRole('button', { name: 'Use V1' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' });
  await expect(toast).toBeVisible();
  expect(await readFile(PRICING, 'utf8')).toContain(
    "import { PlanCard } from '../molecules/PlanCard';",
  );
  expect(await readFile(PLAN_CARD, 'utf8')).toContain("import { Price } from '../atoms/Price';");
  expect(await readFile(PRICE, 'utf8')).toContain('interface PriceProps');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('<PricingSection />');
  await expect(pricing).toContainText('Pro$19');

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  for (const path of [PRICE, PLAN_CARD, PRICING]) expect(await exists(path)).toBe(false);
  await expect(pricing).toHaveCount(0);
});

test('discarding the variants takes the previewed component files away and writes nothing', async ({
  page,
}) => {
  const prompt = await askFor(page, 'A pricing strip under the button');
  const pricing = page.getByRole('main').getByRole('region', { name: 'Pricing' });
  await expect(pricing).toContainText('Starter$9');

  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();

  await expect(pricing).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Order now' })).toBeVisible();
  for (const path of [PRICE, PLAN_CARD, PRICING, OUTSIDE]) expect(await exists(path)).toBe(false);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});
