import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const MENU_CARD_FILE = 'src/components/MenuCard.tsx';
const APP_FILE = 'src/App.tsx';
const GJD_LOG = fixturePath('.guijam/logs/gjd.log');
const WATCHED = [ORDER_BUTTON_FILE, MENU_CARD_FILE, APP_FILE];
const READY_MS = 30_000;
const REPAIR = "Fixing the AI's edits";

interface CliRun {
  request?: string;
  previousAttempt?: boolean;
  repairReasons?: string[];
  wholeSource?: boolean;
}

let fixture: FixtureServer;
let cliLog: string;
const originals = new Map<string, string>();
const savedEnv = { PATH: process.env.PATH };

async function runsSince(start: number): Promise<CliRun[]> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun)
    .slice(start)
    .filter((run) => run.request !== undefined);
}

async function runCount(): Promise<number> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).length;
}

async function logSize(): Promise<number> {
  return stat(GJD_LOG).then(
    (stats) => stats.size,
    () => 0,
  );
}

async function logSince(offset: number): Promise<string> {
  const text = await readFile(GJD_LOG).catch(() => Buffer.alloc(0));
  return text.subarray(offset).toString('utf8');
}

function variants(prompt: Locator): Locator {
  return prompt.getByRole('region', { name: 'Variants' });
}

function tiles(prompt: Locator): Locator {
  return variants(prompt).getByRole('group', { name: 'Pick a variant' }).getByRole('button');
}

async function askAbout(
  page: Page,
  element: Locator,
  file: string,
  request: string,
): Promise<Locator> {
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' })
    .click();
  await element.click({ position: { x: 4, y: 4 } });
  await page
    .getByRole('dialog', { name: `Fine-tune ${file}` })
    .getByRole('button', { name: 'Ask AI' })
    .click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${file}` });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  return prompt;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  cliLog = join(await mkdtemp(join(tmpdir(), 'guijam-fake-claude-')), 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  for (const file of WATCHED) originals.set(file, await readFile(fixturePath(file), 'utf8'));
  await waitForDaemon(widgetRequests(fixture.api), { file: ORDER_BUTTON_FILE, line: 3, column: 5 });
});

test.afterEach(async () => {
  for (const [file, content] of originals) {
    const path = fixturePath(file);
    if ((await readFile(path, 'utf8')) !== content) await writeFile(path, content);
  }
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('a whole-file rewrite of a file the AI saw in full previews, is written by Use and undone', async ({
  page,
}) => {
  const start = await runCount();
  const before = originals.get(MENU_CARD_FILE) ?? '';
  const card = page.locator('article').first();

  const prompt = await askAbout(page, card, MENU_CARD_FILE, 'rewrite this card');

  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  await expect(card).toHaveClass(/rounded-3xl/);
  expect(await readFile(fixturePath(MENU_CARD_FILE), 'utf8')).toBe(before);
  const runs = await runsSince(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.wholeSource).toBe(true);
    expect(run.previousAttempt).toBe(false);
  }

  await variants(prompt).getByRole('button', { name: 'Use V1' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to MenuCard.tsx.' });
  await expect(toast).toBeVisible();
  expect(await readFile(fixturePath(MENU_CARD_FILE), 'utf8')).toBe(
    before.replace('rounded-card', 'rounded-3xl'),
  );

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(fixturePath(MENU_CARD_FILE), 'utf8')).toBe(before);
});

test('a rewrite of a file the AI saw only in part is refused once, with advice', async ({
  page,
}) => {
  const padded = `${originals.get(APP_FILE) ?? ''}${'\n'.repeat(450)}`;
  await writeFile(fixturePath(APP_FILE), padded);
  const start = await runCount();

  const prompt = await askAbout(
    page,
    page.getByRole('heading', { level: 1 }),
    APP_FILE,
    'rewrite the heading',
  );

  const alert = prompt.getByRole('alert');
  await expect(alert).toContainText(
    'None of the 3 variants could be used. It rewrote all of src/App.tsx, but was shown only part of it.',
    { timeout: READY_MS },
  );
  await expect(alert).toContainText(
    'Select a smaller element, or ask for a smaller change, then retry.',
  );
  expect(((await alert.textContent()) ?? '').split('It rewrote all of').length).toBe(2);
  const runs = await runsSince(start);
  expect(runs).toHaveLength(6);
  expect(runs.filter((run) => run.wholeSource)).toHaveLength(0);
  expect(runs.filter((run) => run.previousAttempt)).toHaveLength(3);
  expect(await readFile(fixturePath(APP_FILE), 'utf8')).toBe(padded);
});

test('when every variant fails its checks, GUIJam asks once more with the reasons and shows what comes back', async ({
  page,
}) => {
  const start = await runCount();
  const offset = await logSize();

  const prompt = await askAbout(
    page,
    page.getByRole('button', { name: 'Order now' }),
    ORDER_BUTTON_FILE,
    'make it blue, flaky, pause',
  );

  await expect(
    prompt
      .getByRole('list', { name: 'Progress' })
      .locator('[data-step-label]', { hasText: REPAIR }),
  ).toHaveCount(1, { timeout: READY_MS });
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS(
    'background-color',
    'rgb(37, 99, 235)',
  );
  const runs = await runsSince(start);
  expect(runs).toHaveLength(6);
  expect(runs.slice(0, 3).every((run) => !run.previousAttempt)).toBe(true);
  for (const run of runs.slice(3)) {
    expect(run.previousAttempt).toBe(true);
    expect(run.repairReasons).toEqual([`Its edit quoted code that isn't in ${ORDER_BUTTON_FILE}.`]);
  }
  await expect.poll(() => logSince(offset)).toContain('asking the AI tool to fix its edits');
  await expect.poll(() => logSince(offset)).toMatch(/variants ready.*retried=true/);
  await variants(prompt).getByRole('button', { name: 'Discard' }).click();
});

test('when the second try fails too, one plain reason shows and there is no third try', async ({
  page,
}) => {
  const start = await runCount();

  const prompt = await askAbout(
    page,
    page.getByRole('button', { name: 'Order now' }),
    ORDER_BUTTON_FILE,
    'make it blue, hopeless',
  );

  const alert = prompt.getByRole('alert');
  await expect(alert).toContainText(
    `None of the 3 variants could be used. Its edit quoted code that isn't in ${ORDER_BUTTON_FILE}.`,
    { timeout: READY_MS },
  );
  await expect(alert).toContainText('Retry, or simplify the prompt.');
  await expect(alert).not.toContainText('op 0');
  await expect(alert).not.toContainText("wasn't valid edits");
  await expect.poll(async () => (await runsSince(start)).length).toBe(6);
  await page.waitForTimeout(1_000);
  expect(await runsSince(start)).toHaveLength(6);
  expect(await readFile(fixturePath(ORDER_BUTTON_FILE), 'utf8')).toBe(
    originals.get(ORDER_BUTTON_FILE),
  );
});

test('a crashed AI tool is not retried', async ({ page }) => {
  const start = await runCount();

  const prompt = await askAbout(
    page,
    page.getByRole('button', { name: 'Order now' }),
    ORDER_BUTTON_FILE,
    'make it blue, crash',
  );

  await expect(prompt.getByRole('alert')).toBeVisible({ timeout: READY_MS });
  await page.waitForTimeout(1_000);
  const runs = await runsSince(start);
  expect(runs).toHaveLength(3);
  expect(runs.some((run) => run.previousAttempt)).toBe(false);
});
