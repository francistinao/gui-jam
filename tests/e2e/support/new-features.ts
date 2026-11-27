import { readFile, writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { callsOf, pairWith, startBridge, unpair } from './jira-bridge.js';
import { along, covered, type Point } from './strokes.js';

export interface Component {
  element: Locator;
  file: string;
  path: string;
}

const READY_MS = 60_000;

function name(component: Component): string {
  return component.file.split('/').at(-1) ?? component.file;
}

function variants(prompt: Locator): Locator {
  return prompt.getByRole('region', { name: 'Variants' });
}

export async function inked(page: Page): Promise<number> {
  const canvas = page.locator('canvas.guijam-draw');
  if ((await canvas.count()) === 0) return 0;
  return canvas.evaluate((element) => {
    const drawing = element as HTMLCanvasElement;
    const context = drawing.getContext('2d');
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, drawing.width, drawing.height);
    let count = 0;
    for (let at = 3; at < data.length; at += 4) if ((data[at] ?? 0) > 0) count += 1;
    return count;
  });
}

async function stroke(page: Page, points: readonly (readonly [number, number])[]): Promise<void> {
  const [first, ...rest] = points;
  if (!first) return;
  await page.mouse.move(first[0], first[1]);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

export async function promptForTwo(page: Page, first: Component, second: Component): Promise<void> {
  const before = [await readFile(first.path, 'utf8'), await readFile(second.path, 'utf8')];

  await first.element.click();
  await expect(page.getByRole('dialog', { name: `Fine-tune ${first.file}` })).toBeVisible();
  await second.element.click({ modifiers: ['Shift'] });

  const prompt = page.getByRole('dialog', { name: `Ask AI ${first.file}` });
  const chosen = prompt.getByRole('region', { name: 'Selected components' }).getByRole('listitem');
  await expect(chosen).toHaveCount(2);
  await expect(chosen.first()).toContainText(name(first));
  await expect(chosen.last()).toContainText(name(second));
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('make them bolder');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(
    variants(prompt).getByRole('group', { name: 'Pick a variant' }).getByRole('button'),
  ).toHaveCount(3, { timeout: READY_MS });
  await expect(first.element).toHaveAttribute('data-grouped', 'V1');
  await expect(second.element).toHaveAttribute('data-grouped', 'V1');
  expect([await readFile(first.path, 'utf8'), await readFile(second.path, 'utf8')]).toEqual(before);

  await variants(prompt).getByRole('button', { name: 'Use V1' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toContainText(` and `);
  await expect(toast).toContainText(name(first));
  await expect(toast).toContainText(name(second));
  expect(await readFile(first.path, 'utf8')).toContain('data-grouped="V1"');
  expect(await readFile(second.path, 'utf8')).toContain('data-grouped="V1"');

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect
    .poll(async () => [await readFile(first.path, 'utf8'), await readFile(second.path, 'utf8')])
    .toEqual(before);
  await expect(first.element).not.toHaveAttribute('data-grouped', 'V1');
  await expect(second.element).not.toHaveAttribute('data-grouped', 'V1');
}

export async function drawAndRewind(page: Page, prompt: Locator, element: Locator): Promise<void> {
  await expect(page.locator('canvas.guijam-draw')).toBeVisible();
  const box = await element.boundingBox();
  if (!box) throw new Error('the component is not visible');
  const at = (across: number, down: number): Point => [
    box.x + box.width * across,
    box.y + box.height * down,
  ];
  const first = [at(0.15, 0.5), at(0.85, 0.5)];
  const second = [at(0.2, 0.15), at(0.8, 0.85)];
  await stroke(page, first);
  await expect.poll(() => inked(page)).toBeGreaterThan(0);
  const one = await inked(page);
  await stroke(page, second);
  await expect.poll(() => inked(page)).toBeGreaterThan(one);
  const both = await inked(page);
  await expect.poll(() => covered(page, [...along(first), ...along(second)])).toEqual([]);

  await prompt.getByRole('button', { name: 'Undo stroke' }).click();
  await expect.poll(() => inked(page)).toBe(one);
  await page.keyboard.press('Control+y');
  await expect.poll(() => inked(page)).toBe(both);
  await page.keyboard.press('Control+z');
  await expect.poll(() => inked(page)).toBe(one);
  await expect(prompt.getByRole('button', { name: 'Redo stroke' })).toBeEnabled();
}

export async function sketchWithUndo(page: Page, component: Component): Promise<void> {
  await component.element.click();
  await page
    .getByRole('dialog', { name: `Fine-tune ${component.file}` })
    .getByRole('button', { name: 'Sketch what you want for this component' })
    .click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${component.file}` });
  await drawAndRewind(page, prompt, component.element);

  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('match my sketch');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  await expect(
    variants(prompt).getByRole('group', { name: 'Pick a variant' }).getByRole('button'),
  ).toHaveCount(3, { timeout: READY_MS });
  await expect(component.element).toHaveAttribute('data-sketched', 'V1');
  await variants(prompt).getByRole('button', { name: 'Discard' }).click();
  await expect(component.element).not.toHaveAttribute('data-sketched', 'V1');
}

const SKETCH = 'Sketch what you want for this component';
const TIP_DELAY_MS = 1_800;
const PANEL_EDGE = 12;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not visible');
  return box;
}

export async function steadyBox(page: Page, locator: Locator, quietMs = 600): Promise<Box> {
  let last = await boxOf(locator);
  let since = Date.now();
  const deadline = since + 15_000;
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error('the panel kept moving');
    await page.waitForTimeout(100);
    const box = await boxOf(locator);
    if (box.x !== last.x || box.y !== last.y || box.height !== last.height) {
      last = box;
      since = Date.now();
    }
  }
  return last;
}

export async function settlesAt(locator: Locator, x: number, y: number): Promise<void> {
  await expect
    .poll(async () => {
      const box = await boxOf(locator);
      return Math.abs(box.x - x) <= 1 && Math.abs(box.y - y) <= 1 ? 'there' : `${box.x},${box.y}`;
    })
    .toBe('there');
}

export function sketchToggle(prompt: Locator, label: 'Hide sketch' | 'Show sketch'): Locator {
  return prompt.locator('header').getByRole('button', { name: label, exact: true });
}

export function tipOf(prompt: Locator): Locator {
  return prompt.locator('header [data-tip]');
}

export async function headerButtons(prompt: Locator): Promise<string[]> {
  return prompt
    .locator('header')
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
}

export async function expectTipAfterDelay(
  page: Page,
  target: Locator,
  tip: Locator,
  text: string,
): Promise<void> {
  await target.hover();
  const hovered = Date.now();
  await page.waitForTimeout(1_000);
  await expect(tip).toBeHidden();
  await expect(tip).toBeVisible({ timeout: 2_500 });
  expect(Date.now() - hovered).toBeGreaterThanOrEqual(TIP_DELAY_MS - 100);
  await expect(tip).toHaveText(text);
  await page.mouse.move(2, 2);
  await expect(tip).toBeHidden();
}

async function sketchTwoStrokes(page: Page, element: Locator): Promise<void> {
  await expect(page.locator('canvas.guijam-draw')).toBeVisible();
  const box = await boxOf(element);
  const at = (across: number, down: number): Point => [
    box.x + box.width * across,
    box.y + box.height * down,
  ];
  await stroke(page, [at(0.15, 0.5), at(0.85, 0.5)]);
  await stroke(page, [at(0.2, 0.15), at(0.8, 0.85)]);
}

export async function hideAndShowSketch(page: Page, component: Component): Promise<void> {
  await component.element.click();
  await finetunePanel(page, component).getByRole('button', { name: SKETCH }).click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${component.file}` });
  await sketchTwoStrokes(page, component.element);
  await expect.poll(() => inked(page)).toBeGreaterThan(0);
  const drawn = await inked(page);
  await expect(sketchToggle(prompt, 'Hide sketch')).toHaveCount(0);

  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill('match my sketch, pause');
  await prompt.getByRole('button', { name: 'Generate' }).click();
  await expect(prompt.locator('header')).toContainText('Generating');
  await expect(sketchToggle(prompt, 'Hide sketch')).toHaveCount(0);

  const tiles = variants(prompt).getByRole('group', { name: 'Pick a variant' }).getByRole('button');
  await expect(tiles).toHaveCount(3, { timeout: READY_MS });
  await expect(component.element).toHaveAttribute('data-sketched', 'V1');
  await expect(sketchToggle(prompt, 'Hide sketch')).toBeVisible();
  expect((await headerButtons(prompt)).slice(-2)).toEqual(['Hide sketch', 'Close']);
  expect(await inked(page)).toBe(drawn);
  await expect(page.locator('div.border-dashed').first()).toBeVisible();

  await sketchToggle(prompt, 'Hide sketch').click();

  await expect.poll(() => inked(page)).toBe(0);
  await expect(sketchToggle(prompt, 'Show sketch')).toBeVisible();
  await expect(page.locator('div.border-dashed').first()).toBeVisible();
  await expectTipAfterDelay(
    page,
    sketchToggle(prompt, 'Show sketch'),
    tipOf(prompt),
    'Show sketch',
  );

  await tiles.nth(1).click();
  await expect(component.element).toHaveAttribute('data-sketched', 'V2');
  await expect(sketchToggle(prompt, 'Show sketch')).toBeVisible();
  expect(await inked(page)).toBe(0);

  await page.reload();
  await expect(sketchToggle(prompt, 'Show sketch')).toBeVisible({ timeout: READY_MS });
  expect(await inked(page)).toBe(0);

  await sketchToggle(prompt, 'Show sketch').click();
  await expect.poll(() => inked(page)).toBe(drawn);
  await expect(sketchToggle(prompt, 'Hide sketch')).toBeVisible();

  await variants(prompt).getByRole('button', { name: 'Discard' }).click();
  await expect(component.element).not.toHaveAttribute('data-sketched', /V/);
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => inked(page)).toBe(0);
}

async function grabPoint(panel: Locator): Promise<Point> {
  const header = await boxOf(panel.locator('header'));
  return [header.x + 24, header.y + 8];
}

async function dragBy(page: Page, from: Point, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + dx, from[1] + dy, { steps: 8 });
  await page.mouse.up();
}

function roomyMove(box: Box, viewport: { width: number; height: number }): [number, number] {
  const dx = box.x - 200 >= PANEL_EDGE ? -200 : 200;
  const below = viewport.height - PANEL_EDGE - (box.y + Math.min(box.height, 240));
  const dy = below >= 120 ? 120 : -Math.min(120, box.y - PANEL_EDGE);
  return [dx, dy];
}

export async function dragPanel(page: Page, component: Component): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  await component.element.click();
  const panel = finetunePanel(page, component);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  const resting = await steadyBox(page, panel, 1_000);
  await dragBy(page, await grabPoint(panel), 2, 0);
  await page.waitForTimeout(200);
  await expect(panel).not.toHaveAttribute('data-moved');
  const jiggled = await boxOf(panel);
  expect(jiggled.height !== resting.height || Math.abs(jiggled.x - resting.x) <= 1).toBe(true);

  const start = await steadyBox(page, panel, 1_000);
  const [dx, dy] = roomyMove(start, viewport);
  await dragBy(page, await grabPoint(panel), dx, dy);
  await expect(panel).toHaveAttribute('data-moved', '');
  await settlesAt(panel, start.x + dx, start.y + dy);

  await panel.locator('header').dblclick({ position: { x: 24, y: 8 } });
  await expect(panel).not.toHaveAttribute('data-moved');
  const back = await steadyBox(page, panel);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await component.element.click();
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  const fresh = await steadyBox(page, panel);
  expect(
    Math.abs(fresh.x - back.x) <= 1 && Math.abs(fresh.y - back.y) <= 1,
    `reset at ${back.x},${back.y}, a fresh panel at ${fresh.x},${fresh.y}`,
  ).toBe(true);

  const [nextX, nextY] = roomyMove(fresh, viewport);
  await dragBy(page, await grabPoint(panel), nextX, nextY);
  await settlesAt(panel, fresh.x + nextX, fresh.y + nextY);
  const moved = await boxOf(panel);

  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(100);
  await settlesAt(panel, moved.x, moved.y);
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.setViewportSize({ width: 520, height: 420 });
  await expect
    .poll(async () => {
      const box = await boxOf(panel);
      return (
        box.x >= PANEL_EDGE - 1 &&
        box.y >= PANEL_EDGE - 1 &&
        box.x + box.width <= 520 - PANEL_EDGE + 1 &&
        box.y + box.height <= 420 - PANEL_EDGE + 1
      );
    })
    .toBe(true);
  await page.setViewportSize(viewport);
  await expect.poll(async () => (await boxOf(panel)).x).toBeCloseTo(moved.x, 0);
  await settlesAt(panel, moved.x, moved.y);

  const close = await boxOf(panel.locator('header').getByRole('button', { name: 'Close' }));
  await dragBy(page, [close.x + close.width / 2, close.y + close.height / 2], -120, 80);
  await expect(panel).toBeVisible();
  await settlesAt(panel, moved.x, moved.y);

  await panel.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${component.file}` });
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('data-moved', '');
  await settlesAt(prompt, moved.x, moved.y);

  const before = await boxOf(prompt);
  const sideways =
    before.x + before.width + 20 <= viewport.width - PANEL_EDGE ? 'ArrowRight' : 'ArrowLeft';
  const upward = before.y - 50 >= PANEL_EDGE ? 'ArrowUp' : 'ArrowDown';
  const mover = prompt.getByRole('button', { name: 'Move panel' });
  await mover.focus();
  await page.keyboard.press(sideways);
  await page.keyboard.press(sideways);
  await page.keyboard.press(`Shift+${upward}`);
  await settlesAt(
    prompt,
    before.x + (sideways === 'ArrowRight' ? 20 : -20),
    before.y + (upward === 'ArrowUp' ? -50 : 50),
  );
  await page.keyboard.press('Home');
  await expect(prompt).not.toHaveAttribute('data-moved');

  await prompt.locator('header').getByRole('button', { name: 'Close' }).click();
  await expect(prompt).toHaveCount(0);
}

const ESPRESSO_RGB = 'rgb(59, 36, 24)';

function finetunePanel(page: Page, component: Component): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${component.file}` });
}

function applied(page: Page, component: Component): Locator {
  return page.getByRole('status').filter({ hasText: `Applied to ${name(component)}.` });
}

export async function editText(page: Page, component: Component): Promise<void> {
  const before = await readFile(component.path, 'utf8');
  await component.element.click();
  const panel = finetunePanel(page, component);
  const field = panel.getByRole('textbox', { name: 'Text content', exact: true });
  const original = await field.inputValue();
  expect(original).not.toBe('');

  await field.fill('Freshly roasted & ready');

  await expect(component.element).toHaveText('Freshly roasted & ready', { timeout: READY_MS });
  expect(await readFile(component.path, 'utf8')).toBe(before);
  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = applied(page, component);
  await expect(toast).toBeVisible();
  const written = await readFile(component.path, 'utf8');
  expect(written).toContain('Freshly roasted &amp; ready');
  expect(
    written.split('\n').filter((line, index) => line !== before.split('\n')[index]),
  ).toHaveLength(1);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(component.path, 'utf8')).toBe(before);
  await expect(component.element).toHaveText(original, { timeout: READY_MS });
}

export async function pickThemeColor(page: Page, component: Component): Promise<void> {
  const before = await readFile(component.path, 'utf8');
  await component.element.click();
  const panel = finetunePanel(page, component);
  await panel.getByRole('button', { name: 'Fill color' }).click();
  const colors = page.getByRole('dialog', { name: 'Fill color picker' });

  await colors.getByRole('button', { name: 'Theme color espresso' }).click();

  await expect(component.element).toHaveCSS('background-color', ESPRESSO_RGB, {
    timeout: READY_MS,
  });
  expect(await readFile(component.path, 'utf8')).toBe(before);
  await colors.getByRole('button', { name: 'Theme color espresso' }).press('Escape');
  await expect(colors).toHaveCount(0);
  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = applied(page, component);
  await expect(toast).toBeVisible();
  expect(await readFile(component.path, 'utf8')).toContain('bg-espresso');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(component.path, 'utf8')).toBe(before);
}

export async function dragPadding(page: Page, component: Component): Promise<void> {
  const before = await readFile(component.path, 'utf8');
  await component.element.click();
  const panel = finetunePanel(page, component);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  await expect(bottom).toHaveAttribute('aria-valuetext', '12 · pb-3', { timeout: READY_MS });

  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');

  await expect(bottom).toHaveAttribute('aria-valuetext', '20 · pb-5');
  await expect(component.element).toHaveCSS('padding-bottom', '20px', { timeout: READY_MS });
  expect(await readFile(component.path, 'utf8')).toBe(before);
  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = applied(page, component);
  await expect(toast).toBeVisible();
  expect(await readFile(component.path, 'utf8')).toContain('px-6 pt-3 pb-5');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(component.path, 'utf8')).toBe(before);
}

export interface FoundText extends Component {
  caption: string;
}

const FOUND_ORIGINAL = 'CBPLD Overview';
const FOUND_NEXT = `Bob's "Overview" & more`;
const FOUND_LINE = `  { id: 'overview', title: 'Bob\\'s "Overview" & more' },`;

export async function editFoundText(page: Page, found: FoundText): Promise<void> {
  const before = await readFile(found.path, 'utf8');
  try {
    await found.element.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await found.element.click();
    const panel = finetunePanel(page, found);
    const field = panel.getByRole('textbox', { name: 'Text content', exact: true });
    await expect(field).toHaveValue(FOUND_ORIGINAL, { timeout: READY_MS });
    await expect(panel.getByText(found.caption, { exact: true })).toBeVisible();

    await field.fill(FOUND_NEXT);

    await expect(found.element).toHaveText(FOUND_NEXT, { timeout: READY_MS });
    expect(await readFile(found.path, 'utf8')).toBe(before);
    await panel.getByRole('button', { name: 'Apply' }).click();

    const toast = applied(page, found);
    await expect(toast).toBeVisible();
    const old = before.split('\n');
    const written = await readFile(found.path, 'utf8');
    expect(written.split('\n').filter((line, index) => line !== old[index])).toEqual([FOUND_LINE]);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => readFile(found.path, 'utf8')).toBe(before);
    await expect(found.element).toHaveText(FOUND_ORIGINAL, { timeout: READY_MS });
  } finally {
    if ((await readFile(found.path, 'utf8')) !== before) await writeFile(found.path, before);
  }
}

const JIRA_TEXT = 'Fresh coffee, every morning';
const POST_MS = 30_000;

export async function jiraLoop(
  page: Page,
  component: Component,
  open: () => Promise<void>,
): Promise<void> {
  const bridge = await startBridge();
  const before = await readFile(component.path, 'utf8');
  await pairWith(bridge);
  try {
    await open();
    await component.element.click();
    const panel = finetunePanel(page, component);
    await panel.getByRole('button', { name: 'Link a Jira ticket' }).click();
    await panel.getByRole('button', { name: 'WEB-1 · Rename the hero heading' }).click();
    await expect(panel.getByRole('region', { name: 'Linked ticket' })).toContainText('WEB-1', {
      timeout: READY_MS,
    });
    await expect.poll(() => callsOf(bridge, '/v1/tickets/WEB-1/start').length).toBe(1);
    await panel.getByRole('combobox', { name: 'Move the ticket to' }).selectOption('In Review');
    await panel.getByRole('textbox', { name: 'Text content', exact: true }).fill(JIRA_TEXT);
    await expect(component.element).toHaveText(JIRA_TEXT, { timeout: READY_MS });
    expect(await readFile(component.path, 'utf8')).toBe(before);
    await panel.getByRole('button', { name: 'Apply' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: 'Posts to WEB-1 in 10 s unless you undo.' }),
    ).toBeVisible();
    await expect
      .poll(() => callsOf(bridge, '/v1/tickets/WEB-1/result').length, { timeout: POST_MS })
      .toBe(1);
    const posted = callsOf(bridge, '/v1/tickets/WEB-1/result')[0]?.body ?? {};
    expect(posted).toMatchObject({
      files: [component.file],
      agent: 'Direct edit, no AI',
      transitionId: '31',
    });
    expect(String(posted.src)).toContain(component.file);
    expect(JSON.stringify(posted.changes)).toContain(JIRA_TEXT);
    expect((posted.before as unknown[]).length).toBeGreaterThan(0);
    expect((posted.after as unknown[]).length).toBeGreaterThan(0);
    await expect(page.getByRole('status').filter({ hasText: 'Posted to WEB-1.' })).toBeVisible();
    expect(await readFile(component.path, 'utf8')).toContain(JIRA_TEXT);
  } finally {
    await unpair();
    bridge.server.close();
    if ((await readFile(component.path, 'utf8')) !== before)
      await writeFile(component.path, before);
  }
}
