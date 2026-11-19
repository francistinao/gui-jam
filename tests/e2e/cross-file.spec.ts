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
const MENU_CARD = fixturePath('src/components/MenuCard.tsx');
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const IMPORT = "import { OrderButton } from './components/OrderButton';";
const TAG = '            <OrderButton />';

let fixture: FixtureServer;
let workDir: string;
let cliLog: string;
const originals = new Map<string, string>();
const savedPath = process.env.PATH;

interface CliRun {
  request?: string;
  component?: string | null;
  files?: { path: string; why: string }[];
}

async function cliRuns(): Promise<CliRun[]> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
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

function selectionOutline(page: Page): Locator {
  return page.locator('div.fixed.border-dashed[aria-hidden="true"]');
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  workDir = await mkdtemp(join(tmpdir(), 'guijam-cross-file-'));
  cliLog = join(workDir, 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedPath);
  for (const file of [APP, MENU_CARD, ORDER_BUTTON]) {
    originals.set(file, await readFile(file, 'utf8'));
  }
  fixture = await startFixtureServer();
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  for (const [file, content] of originals) {
    if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
  }
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedPath;
  await rm(workDir, { recursive: true, force: true });
});

test('removing a component edits the file that renders it, keeps Undo and brings it back', async ({
  page,
}) => {
  const app = originals.get(APP) ?? '';
  const orderButton = originals.get(ORDER_BUTTON) ?? '';

  const prompt = await askFor(page, 'remove this');

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCount(0);
  await expect(variants.getByRole('note')).toContainText(['Not on the page in this variant.']);
  await expect(selectionOutline(page)).toHaveCount(0);
  await expect(variants.locator('dd.font-mono')).toHaveText('App.tsx');
  expect(await readFile(APP, 'utf8')).toBe(app);
  const run = (await cliRuns()).at(-1);
  expect(run?.component).toBe('OrderButton (the selected element is its root element)');
  expect(run?.files).toEqual([{ path: 'src/App.tsx', why: 'renders OrderButton' }]);

  await variants.getByRole('button', { name: 'Use V1' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' });
  await expect(toast).toBeVisible();
  expect(await readFile(APP, 'utf8')).toBe(app.replace(`${IMPORT}\n`, '').replace(`${TAG}\n`, ''));
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(orderButton);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCount(0);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('Change undone.');
  expect(await readFile(APP, 'utf8')).toBe(app);
  await expect(page.getByRole('button', { name: 'Order now' })).toBeVisible();
});

test('moving a component edits both files in one variant, and the outline follows it', async ({
  page,
}) => {
  const app = originals.get(APP) ?? '';
  const card = originals.get(MENU_CARD) ?? '';

  const prompt = await askFor(page, 'move this into the menu card');

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  const moved = page.locator('#menu').getByRole('button', { name: 'Order now' });
  await expect(moved).toHaveCount(3);
  await expect(
    page.locator('main > section').first().getByRole('button', { name: 'Order now' }),
  ).toHaveCount(0);
  await expect(variants.locator('dd.font-mono')).toHaveText('App.tsx, MenuCard.tsx');
  await expect(variants.locator('[data-change-file]')).toContainText([
    'src/App.tsx',
    'src/components/MenuCard.tsx',
  ]);
  const target = await moved.first().boundingBox();
  await expect
    .poll(async () => {
      const outline = await selectionOutline(page).boundingBox();
      return outline && target ? Math.round(Math.abs(outline.y + 2 - target.y)) : null;
    })
    .toBeLessThan(2);
  await expect(variants.getByRole('note')).not.toContainText(['Not on the page in this variant.']);
  const run = (await cliRuns()).at(-1);
  expect(run?.files).toEqual([
    { path: 'src/App.tsx', why: 'renders OrderButton' },
    { path: 'src/components/MenuCard.tsx', why: 'named in the request' },
  ]);
  expect(await readFile(APP, 'utf8')).toBe(app);
  expect(await readFile(MENU_CARD, 'utf8')).toBe(card);

  await variants.getByRole('button', { name: 'Use V1' }).click();

  const toast = page
    .getByRole('status')
    .filter({ hasText: 'Applied to App.tsx and MenuCard.tsx.' });
  await expect(toast).toBeVisible();
  const movedApp = await readFile(APP, 'utf8');
  const movedCard = await readFile(MENU_CARD, 'utf8');
  expect(movedApp).not.toContain('<OrderButton');
  expect(movedApp).not.toContain(IMPORT);
  expect(movedCard).toContain("import { OrderButton } from './OrderButton';");
  expect(movedCard.match(/<OrderButton \/>/g)).toHaveLength(1);
  await expect(
    page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' }),
  ).toBeVisible();

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('Change undone.');
  expect(await readFile(APP, 'utf8')).toBe(app);
  expect(await readFile(MENU_CARD, 'utf8')).toBe(card);
  await expect(page.locator('#menu').getByRole('button', { name: 'Order now' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCount(1);
});

test('commenting out a component hides it and writes a JSX comment where it is rendered', async ({
  page,
}) => {
  const app = originals.get(APP) ?? '';

  const prompt = await askFor(page, 'comment this out');

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCount(0);

  await variants.getByRole('button', { name: 'Use V1' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' })).toBeVisible();
  expect(await readFile(APP, 'utf8')).toBe(
    app.replace(IMPORT, `// ${IMPORT}`).replace(TAG, '            {/* <OrderButton /> */}'),
  );
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCount(0);
});
