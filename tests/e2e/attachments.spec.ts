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
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';
import { png } from './support/images.js';
import { searchPath } from './support/process.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };

let fixture: FixtureServer;
let original: string;
let cliLog: string;
let configHome: string;
const savedEnv = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

interface CliRun {
  request?: string;
  images?: string[];
  imageSizes?: ([number, number] | null)[];
  inspiration?: string | null;
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

async function openPrompt(page: Page): Promise<Locator> {
  await openFixture(page, fixture.url);
  const draw = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await draw.click();
  await circle(page, page.getByRole('button', { name: 'Order now' }));
  return page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
}

async function choose(
  page: Page,
  prompt: Locator,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) {
  const chooser = page.waitForEvent('filechooser');
  await prompt.getByRole('button', { name: 'Add image' }).click();
  await (await chooser).setFiles(files);
}

async function transfer(
  target: Locator,
  kind: 'paste' | 'drop',
  files: { name: string; type: string; base64: string }[],
) {
  await target.evaluate(
    (element, { kind, files }) => {
      const data = new DataTransfer();
      for (const file of files) {
        const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
        data.items.add(new File([bytes], file.name, { type: file.type }));
      }
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    },
    { kind, files },
  );
}

function thumbnails(prompt: Locator): Locator {
  return prompt.getByRole('list', { name: 'Attached images' }).getByRole('img');
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  configHome = await mkdtemp(join(tmpdir(), 'guijam-attach-'));
  cliLog = join(configHome, 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
  await rm(join(configHome, 'guijam'), { recursive: true, force: true });
});

test.afterAll(async () => {
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
  for (const name of ['GUIJAM_GJD_BIN', 'GUIJAM_FAKE_CLAUDE_LOG']) {
    delete process.env[name];
  }
  process.env.PATH = savedEnv.PATH;
  process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  await rm(configHome, { recursive: true, force: true });
});

test('chosen images are downscaled, keep transparency, and reach the model as inspiration', async ({
  page,
}) => {
  const prompt = await openPrompt(page);
  await choose(page, prompt, [
    { name: 'mood.png', mimeType: 'image/png', buffer: png(2400, 1600) },
    { name: 'badge.png', mimeType: 'image/png', buffer: png(300, 200, true) },
  ]);
  await expect(thumbnails(prompt)).toHaveCount(2);
  await expect(prompt.getByRole('img', { name: 'Attachment 1: mood.png' })).toBeVisible();

  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('Match this mood');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
  const run = (await cliRuns()).find((entry) => entry.request === 'Match this mood');
  expect(run?.images).toEqual(['image/jpeg', 'image/png']);
  expect(run?.imageSizes).toEqual([
    [1568, 1045],
    [300, 200],
  ]);
  expect(run?.inspiration).toBe('1-2');
  await variants.getByRole('button', { name: 'Discard' }).click();
});

test('paste and drop add images, other files are refused, and four is the most', async ({
  page,
}) => {
  const prompt = await openPrompt(page);
  const textarea = prompt.getByRole('textbox', { name: 'Describe the change' });
  const image = (name: string) => ({
    name,
    type: 'image/png',
    base64: png(40, 30).toString('base64'),
  });

  await transfer(textarea, 'paste', [image('pasted.png')]);
  await expect(thumbnails(prompt)).toHaveCount(1);
  await expect(textarea).toHaveValue('');

  await transfer(prompt.locator('form'), 'drop', [
    image('dropped.png'),
    { name: 'notes.txt', type: 'text/plain', base64: btoa('hello') },
  ]);
  await expect(thumbnails(prompt)).toHaveCount(2);
  await expect(prompt.getByRole('alert')).toHaveText(
    "notes.txt isn't an image GUIJam can use. Attach a PNG, JPEG, WebP or GIF.",
  );

  await choose(page, prompt, [
    { name: 'a.png', mimeType: 'image/png', buffer: png(20, 20) },
    { name: 'b.png', mimeType: 'image/png', buffer: png(20, 20) },
    { name: 'c.png', mimeType: 'image/png', buffer: png(20, 20) },
  ]);
  await expect(thumbnails(prompt)).toHaveCount(4);
  await expect(prompt.getByRole('alert')).toHaveText(
    "Up to 4 images fit, so 1 wasn't added. Remove one to add another.",
  );
  await expect(prompt.getByRole('button', { name: 'Add image' })).toBeDisabled();

  await prompt.getByRole('button', { name: 'Remove image 2' }).click();

  await expect(thumbnails(prompt)).toHaveCount(3);
  await expect(prompt.getByRole('img', { name: 'Attachment 2: a.png' })).toBeVisible();
  await expect(prompt.getByRole('alert')).toHaveCount(0);
  await expect(prompt.getByRole('button', { name: 'Add image' })).toBeEnabled();
});

test('images stay with the drawing when a run fails and is retried', async ({ page }) => {
  const prompt = await openPrompt(page);
  await choose(page, prompt, [{ name: 'mood.png', mimeType: 'image/png', buffer: png(64, 64) }]);
  const textarea = prompt.getByRole('textbox', { name: 'Describe the change' });
  await textarea.fill('Match this mood, crash');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(prompt.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(thumbnails(prompt)).toHaveCount(1);

  await textarea.fill('Match this mood again');
  await prompt.getByRole('button', { name: 'Retry' }).click();

  await expect(prompt.getByRole('region', { name: 'Variants' })).toBeVisible();
  const run = (await cliRuns()).find((entry) => entry.request === 'Match this mood again');
  expect(run?.images).toEqual(['image/jpeg']);
  expect(run?.inspiration).toBe('1');
  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
});

test('an AI tool that cannot read images says so before it starts', async ({ page }) => {
  await mkdir(join(configHome, 'guijam'), { recursive: true });
  await writeFile(join(configHome, 'guijam/config.toml'), '[providers]\nactive = "qwen-code"\n');
  const prompt = await openPrompt(page);
  await choose(page, prompt, [{ name: 'mood.png', mimeType: 'image/png', buffer: png(64, 64) }]);
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('Match this mood');

  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(prompt.getByRole('alert')).toContainText(
    "Qwen Code can't read images, so sketches and attached images need an AI tool that can.",
  );
  await expect(thumbnails(prompt)).toHaveCount(1);
});
