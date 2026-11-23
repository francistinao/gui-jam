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
const SIGNUP_FILE = 'src/features/rewards/RewardsSignup.tsx';
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const SIGNUP = fixturePath(SIGNUP_FILE);
const ERROR_MESSAGE = fixturePath('src/components/ErrorMessage.tsx');
const WATCHED = [
  SIGNUP_FILE,
  ORDER_BUTTON_FILE,
  'src/components/ErrorMessage.tsx',
  'src/components/FieldHint.tsx',
  'src/features/rewards/RewardsHint.tsx',
];
const EMAIL_ERROR = 'Enter a valid email address.';
const POINTS_HINT = 'Points arrive within a day.';
const USER_PROMPT =
  "I think there's already an existing component, I want you to search it across the codebase";
const READY_MS = 20_000;

interface Listed {
  name: string;
  scope: string;
  path: string;
  used: string;
  import: string | null;
  props: string;
}

interface CliRun {
  request?: string;
  components?: { for: string; listed: Listed[] } | null;
  componentSources?: string[];
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

async function runsSince(start: number): Promise<CliRun[]> {
  return (await cliRuns()).slice(start).filter((run) => run.request !== undefined);
}

function selectTool(page: Page): Locator {
  return page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
}

function variants(prompt: Locator): Locator {
  return prompt.getByRole('region', { name: 'Variants' });
}

function tiles(prompt: Locator): Locator {
  return variants(prompt).getByRole('group', { name: 'Pick a variant' }).getByRole('button');
}

async function askAbout(page: Page, element: Locator, file: string, request: string) {
  await openFixture(page, fixture.url);
  await selectTool(page).click();
  await element.click();
  const finetune = page.getByRole('dialog', { name: `Fine-tune ${file}` });
  await finetune.getByRole('button', { name: 'Ask AI' }).click();
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

test('asking for the existing component swaps the inline error for the shared one, in the selected file only', async ({
  page,
}) => {
  const start = (await cliRuns()).length;
  const before = await fileSnapshot(SIGNUP);
  const shared = await fileSnapshot(ERROR_MESSAGE);

  const prompt = await askAbout(
    page,
    page.getByText(EMAIL_ERROR, { exact: true }),
    SIGNUP_FILE,
    USER_PROMPT,
  );

  await expect(tiles(prompt)).toHaveCount(2, { timeout: READY_MS });
  await expect(tiles(prompt)).toContainText(['Reuse', 'Plain']);
  await expect(
    variants(prompt).getByRole('note').filter({ hasText: '1 variant was dropped' }),
  ).toHaveText("1 variant was dropped: It imports ./components/ErrorMsg, which doesn't exist.");
  await expect(
    variants(prompt).getByRole('note').filter({ hasText: 'Changes across many files' }),
  ).toHaveCount(0);
  await expect(page.getByText(EMAIL_ERROR, { exact: true })).toHaveClass(/text-red-700/);
  expect(await fileSnapshot(SIGNUP)).toEqual(before);

  const runs = await runsSince(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.components?.for).toBe(SIGNUP_FILE);
    const [first] = run.components?.listed ?? [];
    expect(first).toMatchObject({
      name: 'ErrorMessage',
      scope: 'shared',
      path: 'src/components/ErrorMessage.tsx',
      used: 'used in 1 file',
      import: 'import { ErrorMessage } from "../../components/ErrorMessage";',
      props: 'message: string',
    });
    expect(run.components?.listed.map((listed) => listed.name)).not.toContain('RewardsSignup');
    expect(run.componentSources).toContain('src/components/ErrorMessage.tsx');
  }

  await variants(prompt).getByRole('button', { name: 'Use V1' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to RewardsSignup.tsx.' });
  await expect(toast).toBeVisible();
  const written = await readFile(SIGNUP, 'utf8');
  expect(written).toContain(`<ErrorMessage message="${EMAIL_ERROR}" />`);
  expect(written).not.toContain('text-red-500');
  expect(await fileSnapshot(ERROR_MESSAGE)).toEqual(shared);

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(SIGNUP, 'utf8')).toBe(before.content);
});

test('without a hint the prompt still lists a few look-alikes, without their source', async ({
  page,
}) => {
  const start = (await cliRuns()).length;

  const prompt = await askAbout(
    page,
    page.getByText(EMAIL_ERROR, { exact: true }),
    SIGNUP_FILE,
    'make this match the rest of the app',
  );

  await expect(tiles(prompt)).toHaveCount(2, { timeout: READY_MS });
  const runs = await runsSince(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    const listed = run.components?.listed ?? [];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(3);
    expect(listed[0]?.name).toBe('ErrorMessage');
    expect(run.componentSources).toEqual([]);
  }
  await variants(prompt).getByRole('button', { name: 'Discard' }).click();
});

test('a component from the same feature comes before a shared look-alike, and its import is added', async ({
  page,
}) => {
  const start = (await cliRuns()).length;
  const before = await readFile(SIGNUP, 'utf8');

  const prompt = await askAbout(
    page,
    page.getByText(POINTS_HINT, { exact: true }),
    SIGNUP_FILE,
    'use the existing hint component',
  );

  await expect(tiles(prompt)).toHaveCount(2, { timeout: READY_MS });
  const [run] = await runsSince(start);
  expect(run?.components?.listed.slice(0, 2)).toMatchObject([
    {
      name: 'RewardsHint',
      scope: 'same feature',
      import: 'import { RewardsHint } from "./RewardsHint";',
    },
    {
      name: 'FieldHint',
      scope: 'shared',
      import: 'import { FieldHint } from "../../components/FieldHint";',
    },
  ]);

  await variants(prompt).getByRole('button', { name: 'Use V1' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Applied to RewardsSignup.tsx.' }),
  ).toBeVisible();
  const written = await readFile(SIGNUP, 'utf8');
  expect(written).toContain('import { RewardsHint } from "./RewardsHint";');
  expect(written).toContain(`<RewardsHint>${POINTS_HINT}</RewardsHint>`);
  expect(written).not.toBe(before);
});

test('a quick style tweak stays on the fast tier with no component list', async ({ page }) => {
  const start = (await cliRuns()).length;

  const prompt = await askAbout(
    page,
    page.getByRole('button', { name: 'Order now' }),
    ORDER_BUTTON_FILE,
    'make it bold',
  );

  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  const runs = await runsSince(start);
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) expect(run.components).toBeNull();
  await variants(prompt).getByRole('button', { name: 'Discard' }).click();
});
