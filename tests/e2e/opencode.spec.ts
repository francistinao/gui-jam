import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const SOLID_RGB = 'rgb(37, 99, 235)';

interface OpenCodeRun {
  request: string;
  retry: boolean;
  slot: number | null;
  model?: string;
  agent?: string;
  pure: boolean;
  permission?: Record<string, string>;
  mcp?: object;
  schemaInPrompt: boolean;
  isolatedConfig: boolean;
  projectConfigOff: boolean;
}

let fixture: FixtureServer;
let configHome: string;
let runLog: string;
const savedEnv = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

async function runs(): Promise<OpenCodeRun[]> {
  const text = await readFile(runLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenCodeRun);
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
  const tool = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await tool.click();
  await circle(page, page.getByRole('button', { name: 'Order now' }));
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  return prompt;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  configHome = await mkdtemp(join(tmpdir(), 'guijam-opencode-'));
  await mkdir(join(configHome, 'guijam'), { recursive: true });
  await writeFile(
    join(configHome, 'guijam/config.toml'),
    '[providers]\nactive = "opencode"\n\n[providers.opencode]\nmodel = "deepseek/deepseek-chat"\n',
  );
  runLog = join(configHome, 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.GUIJAM_TEST_CONFIG_HOME = configHome;
  process.env.GUIJAM_FAKE_OPENCODE_LOG = runLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
  for (const name of ['GUIJAM_GJD_BIN', 'GUIJAM_TEST_CONFIG_HOME', 'GUIJAM_FAKE_OPENCODE_LOG']) {
    delete process.env[name];
  }
  process.env.PATH = savedEnv.PATH;
  process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  await rm(configHome, { recursive: true, force: true });
});

test('a drawn prompt goes through OpenCode with every tool denied and its answer pulled from prose', async ({
  page,
}) => {
  const before = await fileSnapshot(ORDER_BUTTON);

  const prompt = await ask(page, 'Make it feel more premium');

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(
    variants.getByRole('group', { name: 'Pick a variant' }).getByRole('button'),
  ).toHaveText(['V1Solid', 'V2Deep']);
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS(
    'background-color',
    SOLID_RGB,
  );
  await expect(variants).toContainText('deepseek/deepseek-chat');
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
  const [run] = await runs();
  expect(run).toMatchObject({
    request: 'Make it feel more premium',
    retry: false,
    model: 'deepseek/deepseek-chat',
    agent: 'guijam',
    pure: true,
    permission: { '*': 'deny' },
    mcp: {},
    schemaInPrompt: true,
    isolatedConfig: true,
    projectConfigOff: true,
  });

  await variants.getByRole('button', { name: 'Discard' }).click();
});

test('an answer without JSON is retried once with the reason', async ({ page }) => {
  const prompt = await ask(page, 'Make it blue, unusable at first');

  await expect(
    prompt.getByRole('region', { name: 'Variants' }).getByRole('group', { name: 'Pick a variant' }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await runs())
        .filter((run) => run.request.includes('unusable'))
        .map((run) => `${run.slot}${run.retry ? ' retry' : ''}`)
        .sort(),
    )
    .toEqual(['0', '0 retry', '1', '1 retry', '2', '2 retry']);

  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
});
