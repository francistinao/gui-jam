import { mkdtemp, readFile } from 'node:fs/promises';
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
  openFixture,
  startFixtureServer,
} from './support/fixture.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };

let fixture: FixtureServer;
let cliLog: string;
const savedEnv = { PATH: process.env.PATH };

interface CliRun {
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

async function ask(page: Page, request: string): Promise<Locator> {
  await openFixture(page, fixture.url);
  const draw = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await draw.click();
  await circle(page, page.getByRole('button', { name: 'Order now' }));
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
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
  process.env.PATH = `${FAKE_CLI_DIR}:${savedEnv.PATH ?? ''}`;
  fixture = await startFixtureServer();
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('the active step says what the AI tool is doing and how long it has taken', async ({
  page,
}) => {
  const prompt = await ask(page, 'Make it feel more premium, stepwise');
  const progress = prompt.getByRole('list', { name: 'Progress' });
  const active = progress.locator('li[data-state="active"]');

  await expect(active.locator('[data-step-label]')).toHaveText('Asking Claude Code (sonnet)');
  await expect(active.locator('[data-step-detail]')).toHaveText('Claude Code is thinking…');
  await expect(active.locator('[data-step-elapsed]')).toHaveText(/^\d+ s$/);
  await expect(active.locator('svg[data-spinner]')).toBeVisible();
  await expect(active.locator('[data-step-detail]')).toHaveText('Writing the variants… 3 KB');
  await expect(progress.locator('li[data-state="done"] svg')).not.toHaveCount(0);

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  await variants.getByRole('button', { name: 'Discard' }).click();
});

test('a long run explains the wait in plain words, then can be cancelled', async ({ page }) => {
  await page.clock.install();
  const prompt = await ask(page, 'Make it feel more premium, slowly');
  const status = prompt.getByRole('status');
  await expect(status).toHaveText('Generating…');
  await expect
    .poll(async () => (await cliRuns()).some((run) => run.request?.includes('slowly')))
    .toBe(true);

  await page.clock.fastForward(20_000);
  await expect(status).toHaveText('Still generating. Most changes take 10–40 s.');

  await page.clock.fastForward(30_000);
  await expect(status).toHaveText(
    'Still working: the model is writing three takes on your request.',
  );

  await page.clock.fastForward(45_000);
  await expect(status).toHaveText(
    'Taking longer than usual. It stops on its own after 180 s, or Cancel any time.',
  );
  await expect(prompt.locator('li[data-state="active"] [data-step-elapsed]')).toHaveText(
    /^1 min \d\d s$/,
  );

  await prompt.getByRole('button', { name: 'Cancel' }).click();

  await expect(prompt.getByRole('button', { name: 'Generate' })).toBeVisible();
  await expect
    .poll(async () => (await cliRuns()).some((run) => run.interrupted), { timeout: 5_000 })
    .toBe(true);
});

test('a request the daemon cannot read fails at once instead of waiting for minutes', async () => {
  const send = widgetRequests(fixture.api);
  const started = Date.now();

  const reply = await send('generate.request', {
    runId: 'e2e-too-long',
    ...ORDER_BUTTON_REF,
    prompt: 'x'.repeat(5000),
  });

  expect(reply.type === 'error' && reply.payload.code).toBe('INVALID_REQUEST');
  expect(reply.type === 'error' && reply.payload.message).toContain('unreadable message');
  expect(Date.now() - started).toBeLessThan(5_000);
});
