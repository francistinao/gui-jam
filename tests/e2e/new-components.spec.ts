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
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const LEVELS = ['atoms', 'molecules', 'organisms'];
const PRICE = fixturePath('src/components/atoms/Price.tsx');
const PLAN_CARD = fixturePath('src/components/molecules/PlanCard.tsx');
const PRICING = fixturePath('src/components/organisms/PricingSection.tsx');
const OUTSIDE = fixturePath('src/pages/Pricing.tsx');
const APP = fixturePath('src/App.tsx');
const MENU_CARD = fixturePath('src/components/MenuCard.tsx');

let fixture: FixtureServer;
let original: string;
let originalApp: string;
let originalMenuCard: string;
let workDir: string;
let cliLog: string;
const savedPath = process.env.PATH;

interface CliRun {
  request?: string;
  newUi?: string | null;
  copies?: string | null;
  files?: { path: string; why: string }[];
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
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedPath);
  await removeCreated();
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  originalApp = await readFile(APP, 'utf8');
  originalMenuCard = await readFile(MENU_CARD, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
  if ((await readFile(APP, 'utf8')) !== originalApp) await writeFile(APP, originalApp);
  if ((await readFile(MENU_CARD, 'utf8')) !== originalMenuCard) {
    await writeFile(MENU_CARD, originalMenuCard);
  }
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

test('a redesign of one copy of a shared card goes where that copy is placed, not into the shared card', async ({
  page,
}) => {
  await openFixture(page, fixture.url);
  await page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' }).click();
  await circle(page, page.getByRole('article').filter({ hasText: 'Ensaymada' }));
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/MenuCard.tsx' });
  await expect(prompt.getByRole('note').filter({ hasText: 'Used 3×' })).toHaveText(
    'Used 3× on this page. Style changes apply to every copy. Content changes apply to this one.',
  );
  const request = 'Redesign this card as the chef’s special';
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  const special = page.getByRole('main').getByRole('region', { name: 'Special' });
  await expect(special).toContainText(/Chef’s special \d/);
  const runs = (await cliRuns()).filter((run) => run.request === request);
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) {
    expect(run.copies).toContain(
      'the page shows 3 copies of the selected element, all rendered by one shared component. The selected one is copy 3 of 3 in page order and shows "Ensaymada Buttery brioche with queso and sugar',
    );
    expect(run.copies).toContain(
      'It is placed in src/App.tsx, the <file> with why="places this copy…". When that file renders the copies from a list, change only this copy\'s item',
    );
    expect(run.files?.[0]).toEqual({ path: 'src/App.tsx', why: 'places this copy of MenuCard' });
  }
  expect(await readFile(APP, 'utf8')).toBe(originalApp);

  await variants.getByRole('button', { name: 'Use V1' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' });
  await expect(toast).toBeVisible();
  const used = /<SpecialCard(\d) \/>/.exec(await readFile(APP, 'utf8'));
  expect(used).not.toBeNull();
  expect(await readFile(MENU_CARD, 'utf8')).toBe(originalMenuCard);
  expect(await exists(fixturePath(`src/components/organisms/SpecialCard${used?.[1]}.tsx`))).toBe(
    true,
  );

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(APP, 'utf8')).toBe(originalApp);
  await expect(special).toHaveCount(0);
});

test('new components the AI leaves off the page give one clear error with advice', async ({
  page,
}) => {
  const prompt = await askFor(page, 'Redesign this button');

  const error = prompt.getByText('None of the 3 variants could be used.');
  await expect(error).toBeVisible();
  await expect(error).toContainText(
    "None of the 3 variants could be used. It made new components but didn't put them on the page.",
  );
  await expect(error).toContainText(
    'Retry, and say where the new part goes, for example "replace what this section shows".',
  );
  expect(((await error.textContent()) ?? '').split("didn't put them on the page").length).toBe(2);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});
