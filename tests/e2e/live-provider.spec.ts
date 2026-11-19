import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const PROVIDER = process.env.GUIJAM_LIVE_PROVIDER;
const MODEL = process.env.GUIJAM_LIVE_MODEL;
const ANSWER_MS = 300_000;
const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };

let fixture: FixtureServer;
let original: string;

test.skip(PROVIDER === undefined, 'set GUIJAM_LIVE_PROVIDER to run a real AI tool (spends tokens)');
test.setTimeout(ANSWER_MS + 60_000);

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

async function answered(prompt: Locator): Promise<Locator> {
  const tiles = prompt
    .getByRole('region', { name: 'Variants' })
    .getByRole('group', { name: 'Pick a variant' })
    .getByRole('button');
  const alert = prompt.getByRole('alert');
  await expect(tiles.first().or(alert)).toBeVisible({ timeout: ANSWER_MS });
  if (await alert.isVisible()) {
    throw new Error(`${PROVIDER} did not answer: ${await alert.textContent()}`);
  }
  return tiles;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) throw new Error('playwright.config.ts sets XDG_CONFIG_HOME for every run');
  await mkdir(join(configHome, 'guijam'), { recursive: true });
  const model = MODEL === undefined ? '' : `\n[providers.${PROVIDER}]\nmodel = "${MODEL}"\n`;
  await writeFile(
    join(configHome, 'guijam', 'config.toml'),
    `[providers]\nactive = "${PROVIDER}"\n${model}`,
  );
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

async function ask(page: Page, request: string): Promise<Locator> {
  await openFixture(page, fixture.url);
  await page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' }).click();
  await circle(page, page.getByRole('button', { name: 'Order now' }));
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();
  return prompt;
}

test('a real AI tool answers a drawn prompt, and Use writes a variant that Undo takes back', async ({
  page,
}) => {
  const before = await fileSnapshot(ORDER_BUTTON);
  const prompt = await ask(page, 'Give this button a warmer, friendlier personality');

  const tiles = await answered(prompt);
  await expect(prompt.getByRole('button', { name: 'Ask AI for variations' })).toHaveCount(0);
  await tiles.first().click();
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  await prompt
    .getByRole('button', { name: /^Use V\d$/ })
    .first()
    .click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' });
  await expect(toast).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).not.toBe(before.content);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
});

test('a real AI tool answers a question about the element without changing it', async ({
  page,
}) => {
  const before = await fileSnapshot(ORDER_BUTTON);
  const prompt = await ask(page, 'Which file defines this button?');

  const answer = prompt.getByRole('region', { name: 'Answer' });
  const alert = prompt.getByRole('alert');
  await expect(answer.or(alert)).toBeVisible({ timeout: ANSWER_MS });
  if (await alert.isVisible()) {
    throw new Error(`${PROVIDER} did not answer: ${await alert.textContent()}`);
  }
  await expect(answer).toContainText('OrderButton.tsx');
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
});

test('a real AI tool builds a new component from a sketch, timed to its first and last variant', async ({
  page,
}) => {
  await openFixture(page, fixture.url);
  const draw = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
  await draw.click();
  const anchor = await page.getByRole('button', { name: 'Order now' }).boundingBox();
  if (!anchor) throw new Error('the button is not visible');
  const left = anchor.x + 520;
  const top = anchor.y - 12;
  await page.mouse.move(left, top + 140);
  await page.mouse.down();
  for (const [x, y] of [
    [left, top],
    [left + 300, top],
    [left + 300, top + 140],
    [left + 4, top + 138],
  ] as const) {
    await page.mouse.move(x, y, { steps: 6 });
  }
  await page.mouse.up();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('textbox', { name: 'Describe the change' })
    .fill(
      "Let's add a falling 8-bit or unicode pattern here and color of it is the main color which is blue. When I hover into it, it must have an effect where the 8-bit pattern ripples in a given radius around the cursor when hovered.",
    );
  const started = Date.now();
  await dialog.getByRole('button', { name: 'Generate' }).click();

  const tiles = await answered(dialog);
  const first = Date.now() - started;
  const done = page.getByRole('button', { name: /^Drawing 1: \d variants?$/ });
  await expect(done).toBeVisible({ timeout: ANSWER_MS });
  const all = Date.now() - started;
  const count = await tiles.count();
  const note = dialog.getByText(/variants? (was|were) dropped/);
  const dropped = (await note.count()) > 0 ? ` (${await note.textContent()})` : '';
  const timing = `${PROVIDER} ${MODEL ?? 'default model'} sketch: first variant ${(first / 1000).toFixed(1)} s, all ${(all / 1000).toFixed(1)} s, ${count} variants${dropped}`;
  test.info().annotations.push({ type: 'timing', description: timing });
  console.log(timing);

  await dialog
    .getByRole('region', { name: 'Variants' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(done).toHaveCount(0);
});

test('a real AI tool changes a selected component to match a sketch over it', async ({ page }) => {
  const app = fixturePath('src/App.tsx');
  const beforeApp = await readFile(app, 'utf8');
  const before = await fileSnapshot(ORDER_BUTTON);
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' })
    .click();
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  await page
    .getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' })
    .getByRole('button', { name: 'Sketch what you want for this component' })
    .click();
  const box = await button.boundingBox();
  if (!box) throw new Error('the button is not visible');
  const left = box.x - 8;
  const right = box.x + box.width + 8;
  const top = box.y - 6;
  const bottom = box.y + box.height + 6;
  const middle = (top + bottom) / 2;
  const radius = (bottom - top) / 2;
  const pill: [number, number][] = [];
  for (let step = 0; step <= 8; step += 1) {
    const angle = Math.PI / 2 + (Math.PI * step) / 8;
    pill.push([left + radius + Math.cos(angle) * radius, middle - Math.sin(angle) * radius]);
  }
  for (let step = 0; step <= 8; step += 1) {
    const angle = -Math.PI / 2 + (Math.PI * step) / 8;
    pill.push([right - radius + Math.cos(angle) * radius, middle - Math.sin(angle) * radius]);
  }
  pill.push(pill[0] as [number, number]);
  const star: [number, number][] = [];
  for (let point = 0; point <= 10; point += 1) {
    const angle = -Math.PI / 2 + (Math.PI * point) / 5;
    const reach = point % 2 === 0 ? 9 : 4;
    star.push([box.x + 20 + Math.cos(angle) * reach, middle + Math.sin(angle) * reach]);
  }
  for (const stroke of [pill, star]) {
    const [first, ...rest] = stroke;
    if (!first) continue;
    await page.mouse.move(first[0], first[1]);
    await page.mouse.down();
    for (const [x, y] of rest) await page.mouse.move(x, y, { steps: 3 });
    await page.mouse.up();
  }
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.tsx' });
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it look like my sketch: a pill shape with a star before the label');
  const started = Date.now();
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const tiles = await answered(prompt);
  const first = Date.now() - started;
  const done = page.getByRole('button', { name: /^Drawing 1: \d variants?$/ });
  await expect(done).toBeVisible({ timeout: ANSWER_MS });
  const all = Date.now() - started;
  const count = await tiles.count();
  const note = prompt.getByText(/variants? (was|were) dropped/);
  const dropped = (await note.count()) > 0 ? ` (${await note.textContent()})` : '';
  const timing = `${PROVIDER} ${MODEL ?? 'default model'} sketch over a selection: first variant ${(first / 1000).toFixed(1)} s, all ${(all / 1000).toFixed(1)} s, ${count} variants${dropped}`;
  test.info().annotations.push({ type: 'timing', description: timing });
  console.log(timing);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  await prompt
    .getByRole('button', { name: /^Use V\d$/ })
    .first()
    .click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to OrderButton.tsx.' });
  await expect(toast).toBeVisible();
  const after = await readFile(ORDER_BUTTON, 'utf8');
  console.log(after);
  expect(after).not.toBe(before.content);
  expect(await readFile(app, 'utf8')).toBe(beforeApp);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Change undone.' })).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
});
