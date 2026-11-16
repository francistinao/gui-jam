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

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const BRAND_RGB = 'rgb(190, 18, 60)';
const SOLID_RGB = 'rgb(37, 99, 235)';
const DEEP_RGB = 'rgb(29, 78, 216)';
const OUTLINE_RGB = 'rgb(255, 255, 255)';

let fixture: FixtureServer;
let original: string;
let cliLog: string;
const savedEnv = { PATH: process.env.PATH };

interface CliRun {
  args?: string[];
  request?: string;
  interrupted?: boolean;
}

async function cliRuns(): Promise<CliRun[]> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
}

async function chooseTool(page: Page, name: 'Draw' | 'Select'): Promise<void> {
  await openFixture(page, fixture.url);
  const tool = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
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

async function askAbout(page: Page, element: Locator, request: string): Promise<Locator> {
  await chooseTool(page, 'Draw');
  await circle(page, element);
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  return prompt;
}

function changedLines(before: string, after: string): string[] {
  const afterLines = after.split('\n');
  return before.split('\n').filter((line, index) => line !== afterLines[index]);
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  cliLog = join(await mkdtemp(join(tmpdir(), 'guijam-fake-claude-')), 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = `${FAKE_CLI_DIR}:${savedEnv.PATH ?? ''}`;
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('a drawn prompt shows its progress, then three variants that switch live without writing', async ({
  page,
}) => {
  const button = page.getByRole('button', { name: 'Order now' });
  const before = await fileSnapshot(ORDER_BUTTON);
  const runsBefore = (await cliRuns()).length;

  const prompt = await askAbout(page, button, 'Make it blue with a soft shadow, pause');

  const progress = prompt.getByRole('list', { name: 'Progress' });
  await expect(progress.getByRole('listitem')).toHaveText([
    'Reading <button> at OrderButton.tsx:3',
    'Applying your index.css tokens',
    'Asking Claude Code (haiku)',
    'Checking the variants',
    'Previewing V1',
  ]);
  await expect(progress.getByRole('listitem').nth(2)).toHaveAttribute('data-state', 'active');
  await expect(progress.getByRole('listitem').nth(0)).toHaveAttribute('data-state', 'done');

  const variants = prompt.getByRole('region', { name: 'Variants' });
  const tiles = variants.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
  await expect(tiles).toHaveText(['V1Solid', 'V2Deep', 'V3Outline']);
  await expect(tiles.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveCSS('background-color', SOLID_RGB);
  await expect(variants).toContainText('Blue button.');
  await expect(variants).toContainText('OrderButton.tsx');

  await tiles.nth(1).click();
  await expect(tiles.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveCSS('background-color', DEEP_RGB);
  await tiles.nth(2).click();
  await expect(button).toHaveCSS('background-color', OUTLINE_RGB);
  await tiles.nth(1).click();
  await expect(button).toHaveCSS('background-color', DEEP_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  const runs = await cliRuns();
  expect(runs).toHaveLength(runsBefore + 1);
  expect(runs.at(-1)?.args).toEqual(
    expect.arrayContaining(['--tools', '', '--strict-mcp-config', '--model', 'haiku']),
  );

  await variants.getByRole('button', { name: 'Use V2' }).click();

  await expect(
    page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' }),
  ).toBeVisible();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' });
  await expect(toast).toBeVisible();
  const written = await readFile(ORDER_BUTTON, 'utf8');
  expect(changedLines(before.content, written)).toEqual([
    '    <button type="button" className="rounded-lg bg-brand px-6 py-3 font-medium text-white">',
  ]);
  expect(written).toContain('className="rounded-lg bg-[#1D4ED8] px-6 py-3 font-medium text-white"');

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});

test('a variant whose edit does not apply is dropped with the reason, and Edit prompt keeps the text', async ({
  page,
}) => {
  const button = page.getByRole('button', { name: 'Order now' });
  const before = await fileSnapshot(ORDER_BUTTON);

  const prompt = await askAbout(page, button, 'Make it blue with a soft shadow, invalid');

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(
    variants.getByRole('group', { name: 'Pick a variant' }).getByRole('button'),
  ).toHaveText(['V1Solid', 'V2Outline']);
  await expect(variants.getByRole('note')).toContainText('1 variant was dropped');
  await expect(button).toHaveCSS('background-color', SOLID_RGB);

  await variants.getByRole('button', { name: 'Edit prompt' }).click();

  await expect(prompt.getByRole('textbox', { name: 'Describe the change' })).toHaveValue(
    'Make it blue with a soft shadow, invalid',
  );
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
});

test('a CLI that exits without answering shows PROVIDER_CRASHED with Retry and leaves no preview', async ({
  page,
}) => {
  const button = page.getByRole('button', { name: 'Order now' });
  const before = await fileSnapshot(ORDER_BUTTON);

  const prompt = await askAbout(page, button, 'Make it blue with a soft shadow, crash');

  await expect(prompt.getByRole('alert')).toContainText('Claude Code stopped before answering.');
  await expect(prompt.getByRole('button', { name: 'Retry' })).toBeEnabled();
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
});

test('Ask AI from fine-tune, then Cancel, stops the CLI and leaves no preview', async ({
  page,
}) => {
  await chooseTool(page, 'Select');
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const finetune = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await finetune.getByRole('button', { name: 'Ask AI' }).click();
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  const before = await fileSnapshot(ORDER_BUTTON);
  const runsBefore = (await cliRuns()).length;

  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('Make it blue, slowly');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(prompt.getByRole('status')).toHaveText('Generating…');
  await expect.poll(async () => (await cliRuns()).length).toBeGreaterThan(runsBefore);
  await prompt.getByRole('button', { name: 'Cancel' }).click();

  await expect(prompt.getByRole('button', { name: 'Generate' })).toBeEnabled();
  await expect(prompt.getByRole('textbox', { name: 'Describe the change' })).toHaveValue(
    'Make it blue, slowly',
  );
  await expect
    .poll(async () => (await cliRuns()).some((run) => run.interrupted), { timeout: 5_000 })
    .toBe(true);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a second request on the same element cancels the first run', async () => {
  const send = widgetRequests(fixture.api);
  const first = send('generate.request', {
    runId: 'e2e-first',
    ...ORDER_BUTTON_REF,
    prompt: 'Make it blue with a soft shadow, slowly',
  });
  await expect.poll(async () => (await cliRuns()).at(-1)?.request).toContain('slowly');

  const second = await send('generate.request', {
    runId: 'e2e-second',
    ...ORDER_BUTTON_REF,
    prompt: 'Make it blue with a soft shadow',
  });

  const replaced = await first;
  expect(replaced.type === 'error' && replaced.payload.code).toBe('CANCELLED');
  expect(second.type).toBe('generate.done');
  const discarded = await send('generate.discard', { runId: 'e2e-second' });
  expect(discarded.type).toBe('generate.discarded');
});

test('an exact edit needs no model, and Ask AI for variations asks for three', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Order now' });
  const before = await fileSnapshot(ORDER_BUTTON);
  const runsBefore = (await cliRuns()).length;

  const prompt = await askAbout(page, button, 'make it blue and pill-shaped');

  const variants = prompt.getByRole('region', { name: 'Variants' });
  const tiles = variants.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
  await expect(tiles).toHaveText(['V1Exact']);
  await expect(variants.getByRole('note')).toHaveText('Exact edit — no AI needed.');
  await expect(variants).toContainText('→ bg-blue-600 rounded-full');
  await expect(button).toHaveClass(/\bbg-blue-600\b/);
  await expect(button).toHaveClass(/\brounded-full\b/);
  expect(await cliRuns()).toHaveLength(runsBefore);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  await variants.getByRole('button', { name: 'Ask AI for variations' }).click();

  await expect(tiles).toHaveText(['V1Solid', 'V2Deep', 'V3Outline']);
  const runs = await cliRuns();
  expect(runs).toHaveLength(runsBefore + 1);
  expect(runs.at(-1)?.request).toBe('make it blue and pill-shaped');
  expect(runs.at(-1)?.args).toEqual(expect.arrayContaining(['--model', 'haiku']));
});

test('a question gets an answer whose file references open in the editor', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Order now' });
  const before = await fileSnapshot(ORDER_BUTTON);

  const prompt = await askAbout(page, button, 'where is this button defined?');

  const answer = prompt.getByRole('region', { name: 'Answer' });
  await expect(answer).toContainText('It is rendered at src/components/OrderButton.tsx:3.');
  const opened: string[] = [];
  await page.route('**/__open-in-editor?**', async (route) => {
    opened.push(new URL(route.request().url()).searchParams.get('file') ?? '');
    await route.fulfill({ status: 200, body: '' });
  });
  await answer.getByRole('button', { name: 'src/components/OrderButton.tsx:3' }).click();
  await expect.poll(() => opened).toEqual(['src/components/OrderButton.tsx:3']);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  await answer.getByRole('button', { name: 'Ask another' }).click();
  await expect(prompt.getByRole('textbox', { name: 'Describe the change' })).toHaveValue('');
});

test('an open-ended request uses the standard tier, and a multi-file one says so', async ({
  page,
}) => {
  const button = page.getByRole('button', { name: 'Order now' });

  const prompt = await askAbout(page, button, 'make this feel premium and trustworthy');

  await expect(
    prompt.getByRole('group', { name: 'Pick a variant' }).getByRole('button'),
  ).toHaveCount(3);
  expect((await cliRuns()).at(-1)?.args).toEqual(expect.arrayContaining(['--model', 'sonnet']));

  await prompt.getByRole('button', { name: 'Edit prompt' }).click();
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('refactor this into a shared component');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(prompt.getByRole('note').first()).toContainText(
    'Multi-file changes work best from your CLI session',
  );
});
