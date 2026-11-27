import { readFile, writeFile } from 'node:fs/promises';
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
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';
import { searchPath } from './support/process.js';
import {
  along,
  covered,
  drawCanvas,
  drawStroke,
  type Point,
  savedStrokes,
  unpainted,
} from './support/strokes.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const SIGNUP_FILE = 'src/features/rewards/RewardsSignup.tsx';
const ORDER_BUTTON_FILE = 'src/components/OrderButton.tsx';
const COUNTER_FILE = 'src/components/Counter.tsx';
const SKETCH = 'Sketch what you want for this component';
const EMAIL_ERROR = 'Enter a valid email address.';
const EMAIL_ERROR_TOP = 560;
const READY_MS = 20_000;
const WATCHED = [SIGNUP_FILE, ORDER_BUTTON_FILE, COUNTER_FILE, 'src/App.tsx'];

let fixture: FixtureServer;
const originals = new Map<string, string>();
const savedEnv = { PATH: process.env.PATH };

function selectTool(page: Page): Locator {
  return page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
}

function askAI(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Ask AI ${file}` });
}

function emailError(page: Page): Locator {
  return page.getByText(EMAIL_ERROR, { exact: true });
}

async function startSelecting(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  await selectTool(page).click();
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
}

async function scrollEmailErrorTo(page: Page, top: number): Promise<void> {
  await emailError(page).evaluate((element, wanted) => {
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - wanted);
  }, top);
  await expect
    .poll(() => emailError(page).evaluate((element) => element.getBoundingClientRect().top))
    .toBeCloseTo(top, 0);
}

async function sketchOver(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  await page
    .getByRole('dialog', { name: `Fine-tune ${file}` })
    .getByRole('button', { name: SKETCH })
    .click();
  const prompt = askAI(page, file);
  await expect(prompt).toBeVisible();
  await expect(drawCanvas(page)).toBeVisible();
  return prompt;
}

async function expectEveryStrokeShown(page: Page, strokes: readonly Point[][]): Promise<void> {
  const samples = strokes.flatMap((points) => along(points));
  await expect.poll(() => savedStrokes(page)).toEqual([strokes.length]);
  await expect.poll(() => unpainted(page, samples)).toEqual([]);
  await expect.poll(() => covered(page, samples)).toEqual([]);
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
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
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('every stroke stays in sight while a sketch over a component low on the page grows', async ({
  page,
}) => {
  await startSelecting(page);
  await scrollEmailErrorTo(page, EMAIL_ERROR_TOP);
  const box = await emailError(page).boundingBox();
  if (!box) throw new Error('the email error is not visible');
  const middle = box.y + box.height / 2;
  await sketchOver(page, emailError(page), SIGNUP_FILE);

  const strokes: Point[][] = [
    [
      [box.x + 20, middle + 2],
      [box.x + 200, middle - 4],
      [box.x + box.width - 30, middle + 4],
    ],
    [
      [box.x + box.width - 16, middle - 20],
      [box.x + 700, middle - 40],
      [box.x + 680, middle - 52],
    ],
    [
      [box.x + 40, middle + 50],
      [box.x + 320, middle + 80],
    ],
    [
      [box.x + 12, middle - 90],
      [box.x + 250, middle - 80],
    ],
  ];

  for (const [index, points] of strokes.entries()) {
    await drawStroke(page, points);
    await expectEveryStrokeShown(page, strokes.slice(0, index + 1));
  }
});

test('forty quick strokes in a row are all kept', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await sketchOver(page, button, ORDER_BUTTON_FILE);
  const box = await button.boundingBox();
  if (!box) throw new Error('Order now is not visible');

  const strokes: Point[][] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const x = box.x - 10 + column * 26;
      const y = box.y + 90 + row * 22;
      strokes.push([
        [x, y],
        [x + 16, y + 10],
      ]);
    }
  }
  for (const points of strokes) await drawStroke(page, points, 2);

  await expect.poll(() => savedStrokes(page)).toEqual([40]);
  await expect.poll(() => unpainted(page, strokes.flat())).toEqual([]);
});

test('a stroke that loses pointer capture is kept, and so is the next one', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await sketchOver(page, button, ORDER_BUTTON_FILE);
  const box = await button.boundingBox();
  if (!box) throw new Error('Order now is not visible');
  const start: Point = [box.x, box.y + 80];
  const middle: Point = [box.x + 60, box.y + 90];
  const end: Point = [box.x + 120, box.y + 80];
  const first: Point[] = [start, middle, end];

  await page.mouse.move(...start);
  await page.mouse.down();
  await page.mouse.move(...middle, { steps: 6 });
  await drawCanvas(page).evaluate((canvas, pointer) => {
    canvas.releasePointerCapture(pointer);
  }, 1);
  await page.mouse.move(...end, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => savedStrokes(page)).toEqual([1]);
  const second: Point[] = [
    [box.x, box.y + 130],
    [box.x + 120, box.y + 140],
  ];
  await drawStroke(page, second);
  await expectEveryStrokeShown(page, [first, second]);
});

test('a cancelled pointer keeps what was drawn before the cancel', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await sketchOver(page, button, ORDER_BUTTON_FILE);
  const box = await button.boundingBox();
  if (!box) throw new Error('Order now is not visible');
  const start: Point = [box.x, box.y + 80];
  const end: Point = [box.x + 60, box.y + 96];
  const drawn: Point[] = [start, end];

  await page.mouse.move(...start);
  await page.mouse.down();
  await page.mouse.move(...end, { steps: 6 });
  await drawCanvas(page).evaluate((canvas, pointer) => {
    canvas.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: pointer, isPrimary: true, bubbles: true }),
    );
  }, 1);
  await page.mouse.move(box.x + 140, box.y + 120, { steps: 6 });
  await page.mouse.up();

  await expectEveryStrokeShown(page, [drawn]);
});

test('a click without moving adds no stroke and nothing to undo', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const prompt = await sketchOver(page, button, ORDER_BUTTON_FILE);
  const box = await button.boundingBox();
  if (!box) throw new Error('Order now is not visible');

  await page.mouse.click(box.x + 20, box.y + 100);
  await page.mouse.click(box.x + 60, box.y + 120);

  await expect.poll(() => savedStrokes(page)).toEqual([0]);
  await expect(prompt.getByRole('button', { name: 'Undo stroke' })).toHaveCount(0);

  await drawStroke(page, [
    [box.x, box.y + 100],
    [box.x + 100, box.y + 110],
  ]);
  await expect.poll(() => savedStrokes(page)).toEqual([1]);
  await prompt.getByRole('button', { name: 'Undo stroke' }).click();
  await expect.poll(() => savedStrokes(page)).toEqual([0]);
});

test("another drawing's progress leaves the strokes of the sketch being drawn alone", async ({
  page,
}) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const finetune = page.getByRole('dialog', { name: `Fine-tune ${ORDER_BUTTON_FILE}` });
  await finetune.getByRole('button', { name: 'Ask AI' }).click();
  const running = askAI(page, ORDER_BUTTON_FILE);
  await running.getByRole('textbox', { name: 'Describe the change' }).fill('make it blue, slow');
  await running.getByRole('button', { name: 'Generate' }).click();
  await expect(running.getByRole('button', { name: 'Cancel' })).toBeVisible();

  const counter = page.getByRole('button', { name: /^Cups ordered/ });
  await sketchOver(page, counter, COUNTER_FILE);
  const box = await counter.boundingBox();
  if (!box) throw new Error('the counter is not visible');
  const strokes: Point[][] = [];
  for (let index = 0; index < 6; index += 1) {
    const y = box.y + 80 + index * 24;
    const points: Point[] = [
      [box.x, y],
      [box.x + 90, y + 8],
      [box.x + 180, y],
    ];
    strokes.push(points);
    await drawStroke(page, points);
    await page.waitForTimeout(250);
  }

  await expect.poll(async () => (await savedStrokes(page)).includes(strokes.length)).toBe(true);
  await expect
    .poll(() =>
      unpainted(
        page,
        strokes.flatMap((points) => along(points)),
      ),
    )
    .toEqual([]);

  await page.getByRole('button', { name: /^Drawing 1/ }).click();
  await askAI(page, ORDER_BUTTON_FILE).getByRole('button', { name: 'Cancel' }).click();
  await expect(
    askAI(page, ORDER_BUTTON_FILE).getByRole('button', { name: 'Generate' }),
  ).toBeVisible();
});

test('drawing right after Sketch, while unsaved tweaks revert, lands on the sketch', async ({
  page,
}) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const finetune = page.getByRole('dialog', { name: `Fine-tune ${ORDER_BUTTON_FILE}` });
  await openSection(finetune, 'Fill');
  await finetune.getByRole('textbox', { name: 'Fill hex' }).fill('1D4ED8');
  await expect(finetune.getByRole('button', { name: 'Apply' })).toBeEnabled();
  const box = await button.boundingBox();
  if (!box) throw new Error('Order now is not visible');
  const points: Point[] = [
    [box.x + 10, box.y + box.height / 2],
    [box.x + box.width - 10, box.y + box.height / 2 + 4],
  ];

  await finetune.getByRole('button', { name: SKETCH }).click();
  await drawStroke(page, points, 3);

  const prompt = askAI(page, ORDER_BUTTON_FILE);
  await expect(prompt).toBeVisible();
  await expect.poll(() => savedStrokes(page)).toEqual([1]);
  await expect.poll(() => unpainted(page, along(points))).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('Escape while an input method is composing keeps the sketch; a plain Escape still drops it', async ({
  page,
}) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const prompt = await sketchOver(page, button, ORDER_BUTTON_FILE);
  const box = await button.boundingBox();
  if (!box) throw new Error('Order now is not visible');
  await drawStroke(page, [
    [box.x, box.y + 90],
    [box.x + 120, box.y + 100],
  ]);
  const textbox = prompt.getByRole('textbox', { name: 'Describe the change' });
  await textbox.fill('오늘의');

  await textbox.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        composed: true,
      }),
    );
  });

  await expect(prompt).toBeVisible();
  await expect.poll(() => savedStrokes(page)).toEqual([1]);

  await page.keyboard.press('Escape');

  await expect(prompt).toHaveCount(0);
  await expect.poll(() => savedStrokes(page)).toEqual([]);
});

test.describe('generating after the strokes', () => {
  test('a sketch low on the page still goes out whole', async ({ page }) => {
    await startSelecting(page);
    await scrollEmailErrorTo(page, EMAIL_ERROR_TOP);
    const box = await emailError(page).boundingBox();
    if (!box) throw new Error('the email error is not visible');
    const prompt = await sketchOver(page, emailError(page), SIGNUP_FILE);
    await drawStroke(page, [
      [box.x + 20, box.y + 8],
      [box.x + 300, box.y + 10],
    ]);
    await drawStroke(page, [
      [box.x + box.width - 10, box.y - 10],
      [box.x + 700, box.y - 30],
    ]);
    await expect.poll(() => savedStrokes(page)).toEqual([2]);

    await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('match my sketch');
    await prompt.getByRole('button', { name: 'Generate' }).click();

    await expect(
      prompt
        .getByRole('region', { name: 'Variants' })
        .getByRole('group', { name: 'Pick a variant' })
        .getByRole('button'),
    ).toHaveCount(3, { timeout: READY_MS });
    await prompt
      .getByRole('region', { name: 'Variants' })
      .getByRole('button', { name: 'Discard' })
      .click();
  });
});
