import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
const APP = fixturePath('src/App.tsx');
const MENU_CARD = fixturePath('src/components/MenuCard.tsx');
const GJD_LOG = fixturePath('.guijam/logs/gjd.log');
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const ORDER_BUTTON_SRC = 'src/components/OrderButton.tsx:3:5';
const SKETCH = 'Sketch what you want for this component';
const NOTE = 'Sketch anywhere on the page now, then describe it below.';
const VIEWPORT = { width: 1280, height: 720 };
const MAX_SIDE = 1568;
const MAX_BASE64 = 8_000_000;
const READY_MS = 20_000;

type Box = [number, number, number, number];

interface CliRun {
  args?: string[];
  request?: string;
  images?: string[];
  imageSizes?: ([number, number] | null)[];
  imageBytes?: number[];
  sketch?: { on: string | null; elementBox: Box | null; box: Box } | null;
  closeUp?: boolean;
  interrupted?: boolean;
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

function selectTool(page: Page): Locator {
  return page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
}

function drawTool(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
}

function canvas(page: Page): Locator {
  return page.locator('canvas.guijam-draw');
}

function hoverOutline(page: Page): Locator {
  return page.locator('.guijam-layer div[aria-hidden="true"].border-blue-500:not(.border-dashed)');
}

function badges(page: Page): Locator {
  return page.getByRole('button', { name: /^Drawing \d/ });
}

function tiles(dialog: Locator): Locator {
  return dialog.getByRole('group', { name: 'Pick a variant' }).getByRole('button');
}

function textbox(dialog: Locator): Locator {
  return dialog.getByRole('textbox', { name: 'Describe the change' });
}

function sketchNote(dialog: Locator): Locator {
  return dialog.getByRole('note').filter({ hasText: NOTE });
}

async function startSelecting(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  await selectTool(page).click();
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
}

async function pick(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  const panel = page.getByRole('dialog', { name: `Fine-tune ${file}` });
  await expect(panel).toBeVisible();
  return panel;
}

async function sketchOver(page: Page, element: Locator, file: string): Promise<Locator> {
  const panel = await pick(page, element, file);
  await panel.getByRole('button', { name: SKETCH }).click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${file}` });
  await expect(sketchNote(prompt)).toBeVisible();
  await expect(canvas(page)).toBeVisible();
  return prompt;
}

async function stroke(page: Page, points: readonly (readonly [number, number])[]): Promise<void> {
  const [first, ...rest] = points;
  if (!first) return;
  await page.mouse.move(first[0], first[1]);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

async function boxOf(
  element: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await element.boundingBox();
  if (!box) throw new Error('the element is not visible');
  return box;
}

async function scribbleOver(page: Page, element: Locator): Promise<Box> {
  const box = await boxOf(element);
  const left = box.x - 10;
  const right = box.x + box.width + 10;
  const top = box.y - 8;
  const bottom = box.y + box.height + 8;
  const middle = (top + bottom) / 2;
  await stroke(page, [
    [left + 12, bottom],
    [left, middle],
    [left + 12, top],
    [right - 12, top],
    [right, middle],
    [right - 12, bottom],
    [left + 14, bottom],
  ]);
  const x = box.x + 16;
  const y = middle;
  await stroke(page, [
    [x, y - 6],
    [x + 4, y + 6],
    [x - 6, y - 2],
    [x + 6, y - 2],
    [x - 4, y + 6],
    [x, y - 6],
  ]);
  return [left, top, right - left, bottom - top];
}

async function inked(page: Page): Promise<number> {
  return canvas(page).evaluate((element) => {
    const drawing = element as HTMLCanvasElement;
    const context = drawing.getContext('2d');
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, drawing.width, drawing.height);
    let count = 0;
    for (let at = 3; at < data.length; at += 4) if ((data[at] ?? 0) > 0) count += 1;
    return count;
  });
}

function expectNear(actual: number | undefined, expected: number, slack: number): void {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(slack);
}

async function generate(dialog: Locator, request: string): Promise<void> {
  await textbox(dialog).fill(request);
  await dialog.getByRole('button', { name: 'Generate' }).click();
}

async function discard(dialog: Locator): Promise<void> {
  await dialog
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  cliLog = join(await mkdtemp(join(tmpdir(), 'guijam-fake-claude-')), 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  for (const file of [ORDER_BUTTON, APP, MENU_CARD])
    originals.set(file, await readFile(file, 'utf8'));
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
  await rm(fixturePath('src/assets'), { recursive: true, force: true });
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('a sketch over a selected component goes with the prompt and changes only that component', async ({
  page,
}) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const element = await boxOf(button);
  const before = await fileSnapshot(ORDER_BUTTON);
  const beforeApp = await fileSnapshot(APP);
  const start = (await cliRuns()).length;

  const prompt = await sketchOver(page, button, ORDER_BUTTON_FILE);

  await expect(prompt.getByText('Sketch', { exact: true })).toBeVisible();
  await expect(textbox(prompt)).toHaveAttribute('placeholder', 'Describe what you sketched');
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(prompt.getByRole('button', { name: 'Clear sketch' })).toHaveCount(0);
  const heading = await boxOf(page.getByRole('heading', { level: 1 }));
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2, {
    steps: 4,
  });
  await expect(hoverOutline(page)).toHaveCount(0);

  const drawn = await scribbleOver(page, button);

  await expect.poll(() => inked(page)).toBeGreaterThan(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(badges(page)).toHaveCount(1);
  await expect(prompt.getByRole('button', { name: 'Clear sketch' })).toBeVisible();

  await generate(prompt, 'make it look like my sketch, pause');

  await expect(
    prompt.getByRole('list', { name: 'Progress' }).locator('[data-step-label]', {
      hasText: 'Reading your sketch',
    }),
  ).toHaveCount(1);
  await expect(canvas(page)).toBeHidden();
  await expect(tiles(prompt)).toHaveText(['V1Pill', 'V2Ring', 'V3Plain'], { timeout: READY_MS });
  await expect(page.locator('[data-sketched="V1"]')).toBeVisible();
  await tiles(prompt).nth(1).click();
  await expect(page.locator('[data-sketched="V2"]')).toBeVisible();
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  const runs = (await cliRuns()).slice(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
    expect(run.images).toEqual(['image/jpeg', 'image/jpeg']);
    expect(run.closeUp).toBe(true);
    expect(run.sketch?.on).toBe(ORDER_BUTTON_SRC);
    const elementBox = run.sketch?.elementBox ?? [];
    expectNear(elementBox[0], element.x, 1);
    expectNear(elementBox[1], element.y, 1);
    expectNear(elementBox[2], element.width, 1);
    expectNear(elementBox[3], element.height, 1);
    const box = run.sketch?.box ?? [];
    for (const [index, value] of drawn.entries()) expectNear(box[index], value, 2);
    const [shown, closeUp] = run.imageSizes ?? [];
    expect(shown).toEqual([VIEWPORT.width, VIEWPORT.height]);
    expectNear(closeUp?.[0], drawn[2] + 48, 3);
    expectNear(closeUp?.[1], drawn[3] + 48, 3);
  }

  await prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Use V2' })
    .click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' });
  await expect(toast).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('data-sketched="V2"');
  expect(await fileSnapshot(APP)).toEqual(beforeApp);
  await expect(badges(page)).toHaveCount(0);
  await expect(canvas(page)).toBeHidden();
  await expect(
    page.getByRole('dialog', { name: `Fine-tune ${ORDER_BUTTON_FILE}` }).getByRole('button', {
      name: SKETCH,
    }),
  ).toBeVisible();

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
});

test('the sketch button turns blue under the pointer, so it reads as clickable', async ({
  page,
}) => {
  await startSelecting(page);
  const panel = await pick(
    page,
    page.getByRole('button', { name: 'Order now' }),
    ORDER_BUTTON_FILE,
  );
  const sketch = panel.getByRole('button', { name: SKETCH });
  await expect(sketch).toHaveCSS('cursor', 'pointer');
  await expect(sketch).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  await sketch.hover();

  await expect(sketch).toHaveCSS('background-color', 'rgb(229, 244, 255)');
  await expect(sketch).toHaveCSS('border-top-color', 'rgb(13, 153, 255)');
  await expect(sketch).toHaveCSS('color', 'rgb(3, 74, 193)');

  await page.mouse.move(4, 4);

  await expect(sketch).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Escape');
});

test('Escape drops a sketch draft, and Select picks elements again', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await sketchOver(page, button, ORDER_BUTTON_FILE);
  await scribbleOver(page, button);
  await expect.poll(() => inked(page)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Drawing 1: Draft' })).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(badges(page)).toHaveCount(0);
  await expect(canvas(page)).toBeHidden();
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
  const heading = page.getByRole('heading', { level: 1 });
  await heading.hover();
  await expect(hoverOutline(page)).toHaveCount(1);

  await sketchOver(page, heading, 'src/App.tsx');

  await expect.poll(() => inked(page)).toBe(0);
  await expect(page.getByRole('button', { name: 'Drawing 1: Draft' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(badges(page)).toHaveCount(0);
});

test('Clear sketch keeps the prompt, and a request with no strokes carries no sketch', async ({
  page,
}) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const prompt = await sketchOver(page, button, ORDER_BUTTON_FILE);
  await scribbleOver(page, button);
  await textbox(prompt).fill('Make it feel more premium');

  await prompt.getByRole('button', { name: 'Clear sketch' }).click();

  await expect(textbox(prompt)).toHaveValue('Make it feel more premium');
  await expect(prompt.getByRole('button', { name: 'Clear sketch' })).toHaveCount(0);
  await expect(sketchNote(prompt)).toBeVisible();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => inked(page)).toBe(0);
  await expect(badges(page)).toHaveCount(1);

  const start = (await cliRuns()).length;
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(tiles(prompt)).toHaveText(['V1Solid', 'V2Deep', 'V3Outline'], {
    timeout: READY_MS,
  });
  const runs = (await cliRuns()).slice(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.sketch).toBeNull();
    expect(run.images).toEqual([]);
  }
  await discard(prompt);
  await expect(badges(page)).toHaveCount(0);
});

test('Ask AI on a selected component adds a sketch with the pencil', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const panel = await pick(page, button, ORDER_BUTTON_FILE);
  await panel.getByRole('button', { name: 'Ask AI' }).click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${ORDER_BUTTON_FILE}` });
  await expect(textbox(prompt)).toBeVisible();
  await expect(sketchNote(prompt)).toHaveCount(0);
  await expect(canvas(page)).toBeHidden();

  await prompt.getByRole('button', { name: SKETCH }).click();

  await expect(sketchNote(prompt)).toBeVisible();
  await expect(prompt.getByText('Sketch', { exact: true })).toBeVisible();
  await expect(prompt.getByRole('button', { name: SKETCH })).toHaveCount(0);
  await expect(canvas(page)).toBeVisible();
  await scribbleOver(page, button);
  const start = (await cliRuns()).length;
  await generate(prompt, 'make it look like my sketch');

  await expect(tiles(prompt)).toHaveText(['V1Pill', 'V2Ring', 'V3Plain'], { timeout: READY_MS });
  const runs = (await cliRuns()).slice(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) expect(run.sketch?.on).toBe(ORDER_BUTTON_SRC);
  await discard(prompt);
});

test('a component circled with the Draw tool offers no sketch over it', async ({ page }) => {
  await openFixture(page, fixture.url);
  await drawTool(page).click();
  const box = await boxOf(page.getByRole('button', { name: 'Order now' }));
  const left = box.x - 18;
  const right = box.x + box.width + 18;
  const top = box.y - 14;
  const bottom = box.y + box.height + 14;
  await stroke(page, [
    [left, top + 10],
    [left + 30, top],
    [right, top + 6],
    [right - 4, bottom],
    [left + 6, bottom - 2],
    [left, top + 14],
  ]);

  const prompt = page.getByRole('dialog', { name: `Ask AI ${ORDER_BUTTON_FILE}` });
  await expect(textbox(prompt)).toBeVisible();
  await expect(prompt.getByText('Ask AI', { exact: true })).toBeVisible();
  await expect(prompt.getByRole('button', { name: SKETCH })).toHaveCount(0);
  await expect(sketchNote(prompt)).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(badges(page)).toHaveCount(0);
});

test('a reload keeps the sketch over the component, and drawing goes on', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const prompt = await sketchOver(page, button, ORDER_BUTTON_FILE);
  const drawn = await scribbleOver(page, button);
  await textbox(prompt).fill('make it look like my sketch');
  await expect
    .poll(() =>
      page.evaluate(
        () => sessionStorage.getItem('guijam:jobs')?.includes('like my sketch') ?? false,
      ),
    )
    .toBe(true);
  const before = await inked(page);

  const connected = page.waitForEvent('console', (msg) => msg.text().includes('[vite] connected'));
  await page.reload();
  await connected;

  const restored = page.getByRole('dialog', { name: `Ask AI ${ORDER_BUTTON_FILE}` });
  await expect(textbox(restored)).toHaveValue('make it look like my sketch');
  await expect(sketchNote(restored)).toBeVisible();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => inked(page)).toBeGreaterThan(before * 0.9);

  const extra = drawn[0] + drawn[2] + 30;
  await stroke(page, [
    [drawn[0] + 20, drawn[1] + drawn[3] / 2],
    [extra, drawn[1] + drawn[3] / 2],
  ]);
  await expect(badges(page)).toHaveCount(1);
  const start = (await cliRuns()).length;
  await restored.getByRole('button', { name: 'Generate' }).click();

  await expect(tiles(restored)).toHaveCount(3, { timeout: READY_MS });
  const runs = (await cliRuns()).slice(start);
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.sketch?.on).toBe(ORDER_BUTTON_SRC);
    expectNear(run.sketch?.box[0], drawn[0], 2);
    expectNear((run.sketch?.box[0] ?? 0) + (run.sketch?.box[2] ?? 0), extra, 2);
  }
  await discard(restored);
});

test('Edit prompt after the variants goes back to sketching, with the strokes', async ({
  page,
}) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const prompt = await sketchOver(page, button, ORDER_BUTTON_FILE);
  await scribbleOver(page, button);
  const ink = await inked(page);
  await generate(prompt, 'make it look like my sketch');
  await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
  await expect(canvas(page)).toBeHidden();

  await prompt.getByRole('button', { name: 'Edit prompt' }).click();

  await expect(sketchNote(prompt)).toBeVisible();
  await expect(textbox(prompt)).toHaveValue('make it look like my sketch');
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => inked(page)).toBeGreaterThan(ink * 0.9);
  await expect(page.locator('[data-sketched]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(badges(page)).toHaveCount(0);
});

test.describe('stress', () => {
  test('a heavy sketch over a component is captured fast and stays within the image limits', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await startSelecting(page);
    const button = page.getByRole('button', { name: 'Order now' });
    const box = await boxOf(button);
    expect(box.x - 40).toBeGreaterThan(0);
    const prompt = await sketchOver(page, button, ORDER_BUTTON_FILE);
    const left = box.x - 40;
    const top = box.y - 50;
    const width = box.width + 200;
    const height = box.height + 100;
    await stroke(page, [
      [left, top + height],
      [left, top],
      [left + width, top],
      [left + width, top + height],
      [left + 2, top + height],
    ]);
    let seed = 11;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (let count = 0; count < 119; count += 1) {
      const x = left + 10 + next() * width * 0.7;
      const y = top + 26 + next() * (height - 40);
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let point = 1; point < 12; point += 1) {
        await page.mouse.move(
          Math.min(left + width - 4, x + point * 9 * next()),
          Math.min(top + height - 4, y + Math.sin(point) * 12),
        );
      }
      await page.mouse.up();
    }
    await expect(badges(page)).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    const offset = await logSize();
    const start = (await cliRuns()).length;

    await generate(prompt, 'make it look like my sketch');

    await expect(tiles(prompt)).toHaveCount(3, { timeout: READY_MS });
    const runs = (await cliRuns()).slice(start);
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.images).toEqual(['image/jpeg', 'image/jpeg']);
      for (const size of run.imageSizes ?? []) {
        expect(size?.[0]).toBeLessThanOrEqual(MAX_SIDE);
        expect(size?.[1]).toBeLessThanOrEqual(MAX_SIDE);
      }
      for (const bytes of run.imageBytes ?? []) expect(bytes).toBeLessThan(MAX_BASE64);
      expectNear(run.sketch?.box[2], width, 2);
      expectNear(run.sketch?.box[3], height, 2);
    }
    await expect
      .poll(async () => /variants ready .*sketch="?element/.test(await logSince(offset)))
      .toBe(true);
    const ready = /variants ready .*capture_ms=(\d+)/.exec(await logSince(offset));
    expect(Number(ready?.[1])).toBeLessThan(5_000);
    await discard(prompt);
  });

  test('three sketches over three components share the run slots, and cancel keeps the strokes', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await startSelecting(page);
    const start = (await cliRuns()).length;
    const order = page.getByRole('button', { name: 'Order now' });
    const heading = page.getByRole('heading', { level: 1 });
    const add = page.getByRole('button', { name: 'Add' }).first();

    const first = await sketchOver(page, order, ORDER_BUTTON_FILE);
    await scribbleOver(page, order);
    await generate(first, 'make it look like my sketch, slow');
    await expect(page.getByRole('button', { name: 'Drawing 1: Generating' })).toBeVisible();
    await expect(canvas(page)).toBeHidden();

    const second = await sketchOver(page, heading, 'src/App.tsx');
    await scribbleOver(page, heading);
    await generate(second, 'make it look like my sketch, slow');
    await expect(page.getByRole('button', { name: 'Drawing 2: Generating' })).toBeVisible();
    await expect(canvas(page)).toBeHidden();

    await add.scrollIntoViewIfNeeded();
    const third = await sketchOver(page, add, 'src/components/MenuCard.tsx');
    await scribbleOver(page, add);
    await generate(third, 'make it look like my sketch');
    await expect(third.locator('[data-step-detail]')).toHaveText(
      'Waiting for another drawing to finish…',
    );
    await expect(canvas(page)).toBeHidden();

    await page.getByRole('button', { name: /^Drawing 1/ }).click();
    await expect(canvas(page)).toBeHidden();
    await first.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByRole('button', { name: 'Drawing 1: Draft' })).toBeVisible();
    await expect(sketchNote(first)).toBeVisible();
    await expect(canvas(page)).toBeVisible();
    await expect.poll(() => inked(page)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Drawing 3: 3 variants' })).toBeVisible({
      timeout: READY_MS,
    });

    await page.getByRole('button', { name: /^Drawing 2/ }).click();
    await expect(canvas(page)).toBeHidden();
    await page.getByRole('button', { name: /^Drawing 3/ }).click();
    await expect(tiles(third)).toHaveText(['V1Pill', 'V2Ring', 'V3Plain']);
    await expect(page.locator('[data-sketched="V1"]')).toHaveCount(3);

    const runs = (await cliRuns()).slice(start);
    const on = (file: string) => runs.filter((run) => run.sketch?.on?.startsWith(file)).length;
    expect(on(ORDER_BUTTON_FILE)).toBe(3);
    expect(on('src/App.tsx')).toBe(3);
    expect(on('src/components/MenuCard.tsx')).toBe(3);
    await expect
      .poll(
        async () =>
          (await cliRuns())
            .slice(start)
            .filter(
              (run) =>
                run.interrupted && run.request?.startsWith('make it look like my sketch, slow'),
            ).length,
      )
      .toBe(3);

    await discard(third);
    await page.getByRole('button', { name: /^Drawing 2/ }).click();
    await second.getByRole('button', { name: 'Cancel' }).click();
    await expect(canvas(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Drawing 1/ }).click();
    await expect(canvas(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(badges(page)).toHaveCount(0);
    await expect(canvas(page)).toBeHidden();
  });

  test('entering and leaving sketch mode 25 times leaves nothing behind', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startSelecting(page);
    const start = (await cliRuns()).length;
    const button = page.getByRole('button', { name: 'Order now' });
    const box = await boxOf(button);

    for (let round = 0; round < 25; round += 1) {
      const panel = await pick(page, button, ORDER_BUTTON_FILE);
      if (round % 2 === 0) {
        await panel.getByRole('button', { name: SKETCH }).click();
      } else {
        await panel.getByRole('button', { name: 'Ask AI' }).click();
        await page
          .getByRole('dialog', { name: `Ask AI ${ORDER_BUTTON_FILE}` })
          .getByRole('button', { name: SKETCH })
          .click();
      }
      await expect(canvas(page)).toBeVisible();
      await stroke(page, [
        [box.x + 8, box.y + 8],
        [box.x + box.width - 8, box.y + box.height - 8],
      ]);
      await expect(badges(page)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(badges(page)).toHaveCount(0);
      await expect(canvas(page)).toBeHidden();
    }

    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('guijam:jobs'))).toBeNull();
    await page.getByRole('heading', { level: 1 }).hover();
    await expect(hoverOutline(page)).toHaveCount(1);
    expect((await cliRuns()).length).toBe(start);
    expect(errors).toEqual([]);
  });
});
