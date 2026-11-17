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
import { type FixtureServer, openFixture, startFixtureServer } from './support/fixture.js';

const START_DIR = fileURLToPath(
  new URL('../../fixtures/node24/small-solidstart-tailwind4/', import.meta.url),
);
const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = join(START_DIR, 'src/components/OrderButton.tsx');
const HOME = join(START_DIR, 'src/routes/index.tsx');
const MENU = join(START_DIR, 'src/routes/menu.tsx');
const BLUE_RGB = 'rgb(29, 78, 216)';
const BRAND_RGB = 'rgb(190, 18, 60)';
const LIGHT_BLUE_RGB = 'rgb(37, 99, 235)';
const LATTE_RGB = 'rgb(232, 220, 200)';

let fixture: FixtureServer;
let workDir: string;
const originals = new Map<string, string>();
const savedPath = process.env.PATH;
const savedCwd = process.cwd();

async function select(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  await chooseSelect(page);
}

async function chooseSelect(page: Page): Promise<void> {
  const tool = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

async function pick(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  const panel = page.getByRole('dialog', { name: `Fine-tune ${file}` });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
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

const NODE_MAJOR = Number.parseInt(process.versions.node, 10);

test.skip(NODE_MAJOR < 24, 'SolidStart 2 needs Node 24 or newer');

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(START_DIR);
  workDir = await mkdtemp(join(tmpdir(), 'guijam-solidstart-'));
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = join(workDir, 'runs.jsonl');
  process.env.PATH = `${FAKE_CLI_DIR}:${savedPath ?? ''}`;
  for (const file of [ORDER_BUTTON, HOME, MENU]) originals.set(file, await readFile(file, 'utf8'));
  process.chdir(START_DIR);
  fixture = await startFixtureServer(undefined, START_DIR);
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
    line: 3,
    column: 5,
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  for (const [file, content] of originals) {
    if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
  }
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(START_DIR);
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedPath;
  process.chdir(savedCwd);
  await rm(workDir, { recursive: true, force: true });
});

test('server-rendered solidstart routes carry source locations, hydrate cleanly and boot the toolbar', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || /hydrat/i.test(message.text())) problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  await openFixture(page, fixture.url);

  await expect(page.getByRole('button', { name: 'Order now' })).toHaveAttribute(
    'data-gj-src',
    'src/components/OrderButton.tsx:3:5',
  );
  await expect(page.getByText('Gift cards for every occasion')).toHaveAttribute(
    'data-gj-src',
    'src/routes/index.tsx:22:11',
  );
  await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('fine-tuning a component used by a route previews live and undoes exactly', async ({
  page,
}) => {
  await select(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const panel = await pick(page, button, 'src/components/OrderButton.tsx');
  const fill = panel.getByRole('region', { name: 'Fill' });
  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('BE123C');
  const before = await readFile(ORDER_BUTTON, 'utf8');

  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');

  await expect(button).toHaveCSS('background-color', BLUE_RGB);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Applied to OrderButton.tsx.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(
    before.replace('rounded-lg bg-brand px-6', 'rounded-lg bg-[#1D4ED8] px-6'),
  );
  await expect(button).toHaveCSS('background-color', BLUE_RGB);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Change undone.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});

test('a route module previews without a reload and its style object is edited', async ({
  page,
}) => {
  await select(page);
  await page.evaluate(() => {
    (window as { gjMarker?: boolean }).gjMarker = true;
  });
  const gift = page.getByText('Gift cards for every occasion');
  const panel = await pick(page, gift, 'src/routes/index.tsx');
  const fill = panel.getByRole('region', { name: 'Fill' });
  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('FDE68A');
  const before = await readFile(HOME, 'utf8');

  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');
  await expect(gift).toHaveCSS('background-color', BLUE_RGB);
  expect(await page.evaluate(() => (window as { gjMarker?: boolean }).gjMarker)).toBe(true);
  await panel.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByRole('status')).toContainText('Applied to index.tsx.');
  expect(await readFile(HOME, 'utf8')).toBe(
    before.replace("'background-color': '#fde68a'", "'background-color': '#1D4ED8'"),
  );
  await expect(gift).toHaveCSS('background-color', BLUE_RGB);
  expect(await page.evaluate(() => (window as { gjMarker?: boolean }).gjMarker)).toBe(true);
});

test('after client-side navigation the toolbar stays and the new route is editable', async ({
  page,
}) => {
  await openFixture(page, fixture.url);
  await page.evaluate(() => {
    (window as { gjMarker?: boolean }).gjMarker = true;
  });
  await page.getByRole('link', { name: 'Menu' }).click();
  await expect(page).toHaveURL(/\/menu$/);
  await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toBeVisible();
  await chooseSelect(page);
  const note = page.getByText('Flat white, cortado and a slow pour-over.');
  await expect(note).toHaveAttribute('data-gj-src', 'src/routes/menu.tsx:10:7');

  const panel = await pick(page, note, 'src/routes/menu.tsx');
  const fill = panel.getByRole('region', { name: 'Fill' });
  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');
  await expect(note).toHaveCSS('background-color', BLUE_RGB);
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('status')).toContainText('Unsaved tweaks were reverted.');
  await expect(note).toHaveCSS('background-color', LATTE_RGB);
  expect(await readFile(MENU, 'utf8')).toBe(originals.get(MENU));
  expect(await page.evaluate(() => (window as { gjMarker?: boolean }).gjMarker)).toBe(true);
});

test('a drawn prompt previews a variant in a solidstart component and Use writes it', async ({
  page,
}) => {
  await openFixture(page, fixture.url);
  const draw = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  const button = page.getByRole('button', { name: 'Order now' });
  await circle(page, button);
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it feel more premium');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  await expect(button).toHaveCSS('background-color', LIGHT_BLUE_RGB);
  const before = await readFile(ORDER_BUTTON, 'utf8');
  expect(before).toContain('bg-brand');

  await variants.getByRole('button', { name: 'Use V1' }).click();

  await expect(page.getByRole('status')).toContainText('Applied to OrderButton.tsx.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.replace('bg-brand', 'bg-[#2563EB]'));
});
