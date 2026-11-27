import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import { openSection } from './support/finetune.js';
import {
  FIXTURE_DIR,
  type FixtureServer,
  fileSnapshot,
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';
import { searchPath } from './support/process.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const APP = fixturePath('src/App.tsx');
const MENU_CARD = fixturePath('src/components/MenuCard.tsx');
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const MENU_CARD_FILE = 'src/components/MenuCard.tsx';
const SKETCH = 'Sketch what you want for this component';
const HINT = 'Shift+click to add more components to one Ask AI prompt.';
const READY_MS = 20_000;

interface CliRun {
  request?: string;
  alsoSelected?: string[];
  files?: { path: string; why: string }[];
}

let fixture: FixtureServer;
let cliLog: string;
const originals = new Map<string, string>();
const savedEnv = { PATH: process.env.PATH };

async function cliRuns(): Promise<CliRun[]> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
}

function selectTool(page: Page): Locator {
  return page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
}

function finetune(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${file}` });
}

function askAI(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Ask AI ${file}` });
}

function chosen(dialog: Locator): Locator {
  return dialog.getByRole('region', { name: 'Selected components' }).getByRole('listitem');
}

function textbox(dialog: Locator): Locator {
  return dialog.getByRole('textbox', { name: 'Describe the change' });
}

function tiles(dialog: Locator): Locator {
  return dialog.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
}

function outlines(page: Page): Locator {
  return page.locator('.guijam-layer div[aria-hidden="true"].border-blue-500.border-dashed');
}

function badges(page: Page): Locator {
  return page.getByRole('button', { name: /^Drawing \d/ });
}

function orderNow(page: Page): Locator {
  return page.getByRole('button', { name: 'Order now' });
}

function heading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

function addButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Add', exact: true }).nth(2);
}

async function startSelecting(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  await selectTool(page).click();
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
}

async function shiftClick(element: Locator): Promise<void> {
  await element.click({ modifiers: ['Shift'] });
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  cliLog = join(await mkdtemp(join(tmpdir(), 'guijam-fake-claude-')), 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  for (const file of [ORDER_BUTTON, APP, MENU_CARD]) {
    originals.set(file, await readFile(file, 'utf8'));
  }
  await waitForDaemon(widgetRequests(fixture.api), {
    file: ORDER_BUTTON_FILE,
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
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('the daemon checks every other component, refuses a sixth and drops duplicates', async () => {
  const send = widgetRequests(fixture.api);
  const at = (file: string, line: number, column: number) => ({ file, line, column });
  const ask = async (runId: string, alsoSelected: object[]) => {
    const start = (await cliRuns()).length;
    const reply = await send('generate.request', {
      runId,
      file: ORDER_BUTTON_FILE,
      line: 3,
      column: 5,
      prompt: 'make them bolder',
      alsoSelected,
    });
    const runs = (await cliRuns()).slice(start);
    if (reply.type === 'generate.done') await send('generate.discard', { runId });
    return { reply, runs };
  };

  const unknown = await ask('unknown', [at('src/App.tsx', 1, 1)]);
  const outside = await ask('outside', [at('../../../etc/hosts', 1, 1)]);
  const sixth = await ask('sixth', [
    at('src/App.tsx', 31, 11),
    at('src/App.tsx', 32, 11),
    at('src/App.tsx', 42, 11),
    at('src/App.tsx', 19, 9),
    at(MENU_CARD_FILE, 16, 9),
  ]);
  const twice = await ask('twice', [
    at(ORDER_BUTTON_FILE, 3, 5),
    at('src/App.tsx', 31, 11),
    at('src/App.tsx', 31, 11),
  ]);

  expect(unknown.reply).toMatchObject({ type: 'error', payload: { code: 'INVALID_REQUEST' } });
  expect(outside.reply).toMatchObject({ type: 'error', payload: { code: 'PATH_DENIED' } });
  expect(sixth.reply).toMatchObject({
    type: 'error',
    payload: { code: 'INVALID_REQUEST', message: 'Up to 5 components at a time.' },
  });
  for (const refused of [unknown, outside, sixth]) expect(refused.runs).toEqual([]);
  expect(twice.reply).toMatchObject({ type: 'generate.done', payload: { route: { tier: 'R2' } } });
  expect(twice.runs).toHaveLength(3);
  for (const run of twice.runs) expect(run.alsoSelected).toEqual(['src/App.tsx:31:11']);
});

test('Shift+click gathers components into one prompt, and Use writes every one of them', async ({
  page,
}) => {
  await startSelecting(page);
  const before = {
    button: await fileSnapshot(ORDER_BUTTON),
    app: await fileSnapshot(APP),
    card: await fileSnapshot(MENU_CARD),
  };

  await orderNow(page).click();
  await expect(finetune(page, ORDER_BUTTON_FILE).getByText(HINT)).toBeVisible();

  await shiftClick(heading(page));

  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await expect(finetune(page, ORDER_BUTTON_FILE)).toHaveCount(0);
  await expect(chosen(prompt)).toHaveText(['OrderButton.tsx:3', 'App.tsx:31']);
  await textbox(prompt).fill('make them blue and pill-shaped');

  await shiftClick(addButton(page));

  await expect(chosen(prompt)).toHaveText(['OrderButton.tsx:3', 'App.tsx:31', 'MenuCard.tsx:16']);
  await expect(textbox(prompt)).toHaveValue('make them blue and pill-shaped');
  await expect(prompt.getByRole('note')).toHaveText(
    'One of these is used more than once on this page. Changes apply to every instance.',
  );
  await expect(prompt.getByRole('button', { name: SKETCH })).toHaveCount(0);
  await expect(outlines(page)).toHaveCount(5);
  await expect(badges(page)).toHaveCount(1);

  const start = (await cliRuns()).length;
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(tiles(prompt)).toHaveText(['V1Solid', 'V2Soft', 'V3Plain'], { timeout: READY_MS });
  await expect(page.locator('[data-grouped="V1"]')).toHaveCount(5);
  await tiles(prompt).nth(1).click();
  await expect(page.locator('[data-grouped="V2"]')).toHaveCount(5);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before.button);
  expect(await fileSnapshot(APP)).toEqual(before.app);
  expect(await fileSnapshot(MENU_CARD)).toEqual(before.card);

  const runs = (await cliRuns()).slice(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.alsoSelected).toEqual(['src/App.tsx:31:11', `${MENU_CARD_FILE}:16:9`]);
    expect(run.files).toEqual(
      expect.arrayContaining([
        { path: 'src/App.tsx', why: 'selected too' },
        { path: MENU_CARD_FILE, why: 'selected too' },
      ]),
    );
  }

  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Use V2' })
    .click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toHaveText(/Applied to .* and 2 other files\./);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('data-grouped="V2"');
  expect(await readFile(APP, 'utf8')).toContain('<h1 data-grouped="V2"');
  expect(await readFile(MENU_CARD, 'utf8')).toContain('data-grouped="V2"');
  await expect(outlines(page)).toHaveCount(1);

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.button.content);
  expect(await readFile(APP, 'utf8')).toBe(before.app.content);
  expect(await readFile(MENU_CARD, 'utf8')).toBe(before.card.content);
});

test('Shift+click again or × takes a component out, and a sixth is refused', async ({ page }) => {
  await startSelecting(page);

  await shiftClick(orderNow(page));
  await expect(finetune(page, ORDER_BUTTON_FILE)).toBeVisible();
  await shiftClick(orderNow(page));
  await expect(finetune(page, ORDER_BUTTON_FILE)).toBeVisible();

  await shiftClick(heading(page));
  await shiftClick(addButton(page));
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await expect(chosen(prompt)).toHaveCount(3);

  await shiftClick(heading(page));
  await expect(chosen(prompt)).toHaveText(['OrderButton.tsx:3', 'MenuCard.tsx:16']);
  await expect(outlines(page)).toHaveCount(4);

  await prompt.getByRole('button', { name: 'Remove OrderButton.tsx:3' }).click();

  const card = askAI(page, MENU_CARD_FILE);
  await expect(card).toBeVisible();
  await expect(chosen(card)).toHaveCount(0);
  await expect(card.getByRole('button', { name: SKETCH })).toBeVisible();
  await expect(outlines(page)).toHaveCount(1);

  await shiftClick(addButton(page));
  await expect(card).toBeVisible();

  for (const element of [
    orderNow(page),
    heading(page),
    page.getByRole('heading', { level: 2 }),
    page.getByText('Order ahead and pick up at your nearest branch.'),
  ]) {
    await shiftClick(element);
  }
  await expect(chosen(card)).toHaveCount(5);

  await shiftClick(page.getByRole('link', { name: 'Menu' }));

  await expect(
    page.getByRole('status').filter({ hasText: 'Up to 5 components at a time.' }),
  ).toBeVisible();
  await expect(chosen(card)).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(badges(page)).toHaveCount(0);
});

test('Shift+click during a run starts a new selection, and a reload keeps the group', async ({
  page,
}) => {
  await startSelecting(page);
  await orderNow(page).click();
  await shiftClick(heading(page));
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await textbox(prompt).fill('make them bolder');
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('guijam:jobs')?.includes('App.tsx:31') ?? false),
    )
    .toBe(true);

  const connected = page.waitForEvent('console', (msg) => msg.text().includes('[vite] connected'));
  await page.reload();
  await connected;

  const restored = askAI(page, ORDER_BUTTON_FILE);
  await expect(chosen(restored)).toHaveText(['OrderButton.tsx:3', 'App.tsx:31']);
  await expect(textbox(restored)).toHaveValue('make them bolder');
  await expect(outlines(page)).toHaveCount(2);

  await selectTool(page).click();
  const start = (await cliRuns()).length;
  await textbox(restored).fill('make them bolder, pause');
  await restored.getByRole('button', { name: 'Generate' }).click();
  await expect(restored.getByRole('button', { name: 'Cancel' })).toBeVisible();

  await shiftClick(addButton(page));

  await expect(finetune(page, MENU_CARD_FILE)).toBeVisible();
  await expect(restored).toHaveCount(0);
  await expect(badges(page)).toHaveCount(1);

  await badges(page).click();

  await expect(tiles(restored)).toHaveCount(3, { timeout: READY_MS });
  const runs = (await cliRuns()).slice(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) expect(run.alsoSelected).toEqual(['src/App.tsx:31:11']);
  await restored
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(badges(page)).toHaveCount(0);
});

test('two components in one file are edited together and land in one commit', async ({ page }) => {
  await startSelecting(page);
  const before = await fileSnapshot(APP);
  await page.getByRole('heading', { level: 2 }).click();
  await shiftClick(heading(page));
  const prompt = askAI(page, 'src/App.tsx');
  await expect(chosen(prompt)).toHaveText(['App.tsx:42', 'App.tsx:31']);

  const start = (await cliRuns()).length;
  await textbox(prompt).fill('make them bigger');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  await expect(page.locator('h1[data-grouped="V1"], h2[data-grouped="V1"]')).toHaveCount(2);
  const runs = (await cliRuns()).slice(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.alsoSelected).toEqual(['src/App.tsx:31:11']);
    expect(run.files ?? []).not.toContainEqual({ path: 'src/App.tsx', why: 'selected too' });
  }

  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Use V1' })
    .click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' });
  await expect(toast).toBeVisible();
  const written = await readFile(APP, 'utf8');
  expect(written).toContain('<h1 data-grouped="V1"');
  expect(written).toContain('<h2 data-grouped="V1"');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(APP, 'utf8')).toBe(before.content);
});

test('Shift+click reverts unsaved Fine-tune tweaks, and Edit prompt lets the group grow again', async ({
  page,
}) => {
  await startSelecting(page);
  await orderNow(page).click();
  await (await openSection(finetune(page, ORDER_BUTTON_FILE), 'Radius'))
    .getByRole('button', { name: 'Radius full' })
    .click();
  await expect(orderNow(page)).toHaveCSS('border-top-left-radius', '9999px');

  await shiftClick(heading(page));

  await expect(
    page.getByRole('status').filter({ hasText: 'Unsaved tweaks were reverted.' }),
  ).toBeVisible();
  await expect(orderNow(page)).toHaveCSS('border-top-left-radius', '8px');
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await expect(chosen(prompt)).toHaveCount(2);

  await textbox(prompt).fill('make them bolder');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  await expect(chosen(prompt)).toHaveCount(2);
  await expect(prompt.getByRole('button', { name: /^Remove / })).toHaveCount(0);

  await prompt.getByRole('button', { name: 'Edit prompt' }).click();

  await expect(prompt.getByRole('button', { name: /^Remove / })).toHaveCount(2);
  await expect(textbox(prompt)).toHaveValue('make them bolder');
  await shiftClick(addButton(page));
  await expect(chosen(prompt)).toHaveText(['OrderButton.tsx:3', 'App.tsx:31', 'MenuCard.tsx:16']);
  await page.keyboard.press('Escape');
  await expect(badges(page)).toHaveCount(0);
});

test('a question about a group gets an answer and changes nothing', async ({ page }) => {
  await startSelecting(page);
  const before = { button: await fileSnapshot(ORDER_BUTTON), app: await fileSnapshot(APP) };
  await orderNow(page).click();
  await shiftClick(heading(page));
  const prompt = askAI(page, ORDER_BUTTON_FILE);
  const start = (await cliRuns()).length;

  await textbox(prompt).fill('where are these defined?');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(prompt.getByRole('region', { name: 'Answer' })).toContainText(
    `It is rendered at ${ORDER_BUTTON_FILE}:3.`,
  );
  const runs = (await cliRuns()).slice(start);
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) expect(run.alsoSelected).toEqual(['src/App.tsx:31:11']);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before.button);
  expect(await fileSnapshot(APP)).toEqual(before.app);
  await page.keyboard.press('Escape');
});

test('a new group waits for a free drawing slot', async ({ page }) => {
  await startSelecting(page);
  for (const [element, file] of [
    [orderNow(page), ORDER_BUTTON_FILE],
    [heading(page), 'src/App.tsx'],
    [addButton(page), MENU_CARD_FILE],
  ] as const) {
    await element.click();
    await finetune(page, file).getByRole('button', { name: 'Ask AI' }).click();
    await expect(askAI(page, file)).toBeVisible();
  }
  await page.getByRole('link', { name: 'Menu' }).click();
  await expect(finetune(page, 'src/App.tsx')).toBeVisible();
  await expect(badges(page)).toHaveCount(3);

  await shiftClick(page.getByRole('link', { name: 'Branches' }));

  await expect(
    page.getByRole('status').filter({ hasText: 'Up to 3 drawings at a time.' }),
  ).toBeVisible();
  await expect(finetune(page, 'src/App.tsx')).toBeVisible();
  await expect(badges(page)).toHaveCount(3);
});
