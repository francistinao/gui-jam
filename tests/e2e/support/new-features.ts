import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';

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
  return page.locator('canvas.guijam-draw').evaluate((element) => {
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
  const at = (across: number, down: number) =>
    [box.x + box.width * across, box.y + box.height * down] as const;
  await stroke(page, [at(0.15, 0.5), at(0.85, 0.5)]);
  await expect.poll(() => inked(page)).toBeGreaterThan(0);
  const one = await inked(page);
  await stroke(page, [at(0.2, 0.15), at(0.8, 0.85)]);
  await expect.poll(() => inked(page)).toBeGreaterThan(one);
  const both = await inked(page);

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
