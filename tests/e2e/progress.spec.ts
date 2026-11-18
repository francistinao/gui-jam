import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { searchPath } from './support/process.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const TIMINGS = join(FIXTURE_DIR, '.guijam', 'run', 'timings.json');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };

let fixture: FixtureServer;
let cliLog: string;
const savedEnv = { PATH: process.env.PATH };

interface CliRun {
  request?: string;
  slot?: number | null;
  interrupted?: boolean;
}

const BRAND_RGB = 'rgb(190, 18, 60)';
const SOLID_RGB = 'rgb(37, 99, 235)';
const DEEP_RGB = 'rgb(29, 78, 216)';

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
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
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
  await expect(active.locator('[data-step-detail]')).toHaveText('Writing the variants… 7 KB');
  await expect(progress.locator('li[data-state="done"] svg')).not.toHaveCount(0);

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  await variants.getByRole('button', { name: 'Discard' }).click();
});

test('a long run explains the wait in plain words, then can be cancelled', async ({ page }) => {
  await rm(TIMINGS, { force: true });
  await page.clock.install();
  const prompt = await ask(page, 'Make it feel more premium, slowly');
  const status = prompt.getByRole('status');
  await expect(status).toHaveText('Generating…');
  await expect
    .poll(async () => (await cliRuns()).some((run) => run.request?.includes('slowly')))
    .toBe(true);

  await page.clock.fastForward(20_000);
  await expect(status).toHaveText('Still generating. Most changes take 10 to 40 s.');

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
    .poll(
      async () =>
        (await cliRuns())
          .filter((run) => run.interrupted && run.request?.includes('slowly'))
          .map((run) => run.slot)
          .sort(),
      { timeout: 5_000 },
    )
    .toEqual([0, 1, 2]);
});

test('after three runs the wait is quoted from how long they took', async ({ page }) => {
  await rm(TIMINGS, { force: true });
  for (const take of [1, 2, 3]) {
    const prompt = await ask(page, `Make it feel more premium, take ${take}`);
    const variants = prompt.getByRole('region', { name: 'Variants' });
    await expect(variants.getByRole('button', { name: 'Discard' })).toBeVisible();
    await variants.getByRole('button', { name: 'Discard' }).click();
  }
  await page.clock.install();

  const prompt = await ask(page, 'Make it feel more premium, slowly again');
  await page.clock.fastForward(20_000);

  await expect(prompt.getByRole('status')).toHaveText(
    /^Still generating\. With this AI tool and model the first variant usually takes about \d+ s\.$/,
  );
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(prompt.getByRole('button', { name: 'Generate' })).toBeVisible();
});

test('variants show as they arrive, and Discard stops the one still being written', async ({
  page,
}) => {
  const prompt = await ask(page, 'Make it blue, staggered');
  const variants = prompt.getByRole('region', { name: 'Variants' });
  const button = page.getByRole('button', { name: 'Order now' });

  await expect(
    variants.getByRole('group', { name: 'Pick a variant' }).getByRole('button'),
  ).toHaveText(['V1Solid', 'V2Deep']);
  await expect(variants.locator('[data-writing="V3"]')).toBeVisible();
  await expect(variants).toContainText('Writing one more variant…');
  await expect(button).toHaveCSS('background-color', SOLID_RGB);

  await variants.getByRole('button', { name: 'V2 · Deep' }).click();

  await expect(button).toHaveCSS('background-color', DEEP_RGB);

  await variants.getByRole('button', { name: 'Discard' }).click();

  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  await expect
    .poll(
      async () =>
        (await cliRuns())
          .filter((run) => run.interrupted && run.request?.includes('staggered'))
          .map((run) => run.slot),
      { timeout: 5_000 },
    )
    .toEqual([2]);
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
