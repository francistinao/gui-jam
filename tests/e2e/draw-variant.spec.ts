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

// The daemon resolves `claude` on the PATH it inherits from the dev server, so this
// stand-in answers instead of the real CLI and no tokens are spent.
const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const BRAND_RGB = 'rgb(190, 18, 60)';
const VARIANT_RGB = 'rgb(37, 99, 235)';

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

/** A rough loop around the element, as a developer would circle it. */
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
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
    line: 3,
    column: 5,
  });
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

test('circling an element and asking for a change previews one variant; Use writes it', async ({
  page,
}) => {
  await chooseTool(page, 'Draw');
  const button = page.getByRole('button', { name: 'Order now' });
  await circle(page, button);
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  const before = await fileSnapshot(ORDER_BUTTON);

  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('Make it blue');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variant = prompt.getByRole('region', { name: 'Variant' });
  await expect(variant).toContainText('Blue button');
  await expect(variant).toContainText('Swapped the brand fill for blue.');
  await expect(variant).toContainText(
    '3 + <button type="button" className="rounded-lg bg-[#2563EB] px-6',
  );
  await expect(button).toHaveCSS('background-color', VARIANT_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
  const [run] = await cliRuns();
  expect(run?.request).toBe('Make it blue');
  expect(run?.args).toEqual(
    expect.arrayContaining(['--tools', '', '--strict-mcp-config', '--model', 'haiku']),
  );

  await variant.getByRole('button', { name: 'Use' }).click();

  await expect(
    page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' }),
  ).toBeVisible();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' });
  await expect(toast).toBeVisible();
  const written = await readFile(ORDER_BUTTON, 'utf8');
  expect(changedLines(before.content, written)).toEqual([
    '    <button type="button" className="rounded-lg bg-brand px-6 py-3 font-medium text-white">',
  ]);
  expect(written).toContain('className="rounded-lg bg-[#2563EB] px-6 py-3 font-medium text-white"');

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
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
