import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { openSection } from './finetune.js';
import type { Component } from './new-features.js';
import { cliRuns, type References } from './references.js';

const READY_MS = 60_000;

function panelOf(page: Page, component: Component): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${component.file}` });
}

async function opened(page: Page, component: Component): Promise<Locator> {
  await component.element.click();
  const panel = panelOf(page, component);
  await expect(panel.getByText('Reading the element…')).toHaveCount(0, { timeout: READY_MS });
  return panel;
}

async function applyAndKeep(panel: Locator, path: string): Promise<string> {
  const before = await readFile(path, 'utf8');
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(() => readFile(path, 'utf8'), { timeout: READY_MS }).not.toBe(before);
  return readFile(path, 'utf8');
}

async function selectTool(page: Page): Promise<void> {
  const select = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' });
  await expect(select).toBeVisible({ timeout: READY_MS });
  if ((await select.getAttribute('aria-pressed')) !== 'true') await select.click();
}

async function history(page: Page): Promise<Locator> {
  const panel = page.getByRole('dialog', { name: 'History' });
  if (!(await panel.isVisible())) {
    await page
      .getByRole('toolbar', { name: 'GUIJam' })
      .getByRole('button', { name: 'History' })
      .click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function flip(
  page: Page,
  path: string,
  text: string,
  button: 'Undo' | 'Redo',
): Promise<void> {
  const before = await readFile(path, 'utf8');
  const row = (await history(page)).getByRole('listitem').filter({ hasText: text }).first();
  await row.getByRole('button', { name: button }).click();
  await expect.poll(() => readFile(path, 'utf8'), { timeout: READY_MS }).not.toBe(before);
  await page.waitForTimeout(1500);
  await page.waitForLoadState('load');
  const panel = page.getByRole('dialog', { name: 'History' });
  await expect(panel, 'History stays open after the change').toBeVisible();
  await expect(
    panel
      .getByRole('listitem')
      .filter({ hasText: text })
      .first()
      .getByRole('button', { name: button === 'Undo' ? 'Redo' : 'Undo' }),
  ).toBeVisible({ timeout: READY_MS });
}

export async function styleGroups(page: Page, component: Component): Promise<void> {
  const before = await readFile(component.path, 'utf8');
  const panel = await opened(page, component);

  await (await openSection(panel, 'Text')).getByLabel('Font size').fill('18');
  await (await openSection(panel, 'Opacity')).getByLabel('Element opacity').fill('50');
  await panel
    .getByRole('region', { name: 'Stroke', exact: true })
    .getByRole('button', { name: 'Add stroke' })
    .click();
  await panel
    .getByRole('region', { name: 'Effects', exact: true })
    .getByRole('button', { name: 'Add effects' })
    .click();

  await expect(component.element).toHaveCSS('font-size', '18px', { timeout: READY_MS });
  await expect(component.element).toHaveCSS('opacity', '0.5');
  await expect(component.element).toHaveCSS('border-top-width', '1px');
  await expect(component.element).not.toHaveCSS('box-shadow', 'none');
  expect(await readFile(component.path, 'utf8')).toBe(before);
  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible({ timeout: READY_MS });
  const written = await readFile(component.path, 'utf8');
  for (const token of ['text-lg', 'opacity-50', 'shadow-sm', 'border']) {
    expect(written, token).toContain(token);
  }
  expect(
    written.split('\n').filter((line, index) => line !== before.split('\n')[index]),
  ).toHaveLength(1);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(component.path, 'utf8')).toBe(before);
}

export async function pasteStyleOntoClasses(
  page: Page,
  source: Component,
  target: Component,
): Promise<void> {
  const before = await readFile(target.path, 'utf8');
  const panel = await opened(page, source);
  await panel.getByRole('button', { name: 'Copy style' }).click();
  const bar = page.getByRole('region', { name: 'Paste style' });
  await expect(bar).toBeVisible();

  await target.element.click();

  await expect(target.element).toHaveCSS('background-color', 'rgb(190, 18, 60)', {
    timeout: READY_MS,
  });
  expect(await readFile(target.path, 'utf8')).toBe(before);
  await panelOf(page, target).getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible({ timeout: READY_MS });
  const written = await readFile(target.path, 'utf8');
  expect(written).toContain('bg-brand');
  expect(written).toMatch(/px-6\s+py-3|py-3\s+px-6/);
  expect(written).not.toContain('style=');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(target.path, 'utf8')).toBe(before);
  await bar.getByRole('button', { name: 'Stop' }).click();
}

export async function historyRoundTrip(page: Page, component: Component): Promise<void> {
  const before = await readFile(component.path, 'utf8');
  const words = `Order ${Date.now().toString(36)}`;
  let panel = await opened(page, component);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const padded = await applyAndKeep(panel, component.path);
  panel = await opened(page, component);
  await panel.getByRole('textbox', { name: 'Text content', exact: true }).fill(words);
  const both = await applyAndKeep(panel, component.path);
  await page.keyboard.press('Escape');

  await flip(page, component.path, 'Padding', 'Undo');
  await expect.poll(() => readFile(component.path, 'utf8')).not.toContain('pb-5');
  const undone = await readFile(component.path, 'utf8');
  expect(undone).toContain(words);
  expect(undone).toContain('py-3');
  expect(padded).toContain('pb-5');

  await flip(page, component.path, 'Padding', 'Redo');
  await expect.poll(() => readFile(component.path, 'utf8')).toBe(both);

  await flip(page, component.path, words, 'Undo');
  await flip(page, component.path, 'Padding', 'Undo');
  await expect.poll(() => readFile(component.path, 'utf8')).toBe(before);
}

export async function collapsedPanel(page: Page, component: Component): Promise<void> {
  const panel = await opened(page, component);
  const ask = panel.getByRole('button', { name: 'Ask AI' });
  const sketch = panel.getByRole('button', { name: 'Sketch what you want for this component' });
  await expect(ask).toHaveCount(1);
  expect((await ask.boundingBox())?.y ?? 0).toBeLessThan((await sketch.boundingBox())?.y ?? 0);
  for (const name of ['Layout', 'Fill', 'Text', 'Opacity']) {
    await expect(
      panel.getByRole('region', { name, exact: true }).locator('details'),
    ).not.toHaveAttribute('open');
  }
  await expect(
    panel.getByRole('region', { name: 'Layout', exact: true }).locator('summary'),
  ).toContainText('12 24 12 24');
  await expect(
    panel.getByRole('region', { name: 'Fill', exact: true }).locator('summary'),
  ).toContainText('brand');

  await openSection(panel, 'Fill');
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('guijam:sections') ?? ''))
    .toContain('fill');
  await page.reload();
  await selectTool(page);
  const again = await opened(page, component);

  await expect(
    again.getByRole('region', { name: 'Fill', exact: true }).locator('details'),
  ).toHaveAttribute('open');
}

export async function linksAndFigma(
  page: Page,
  component: Component,
  references: References,
  log: string,
): Promise<void> {
  expect(process.env.GUIJAM_FIGMA_API?.startsWith('http://127.0.0.1')).toBe(true);
  const request = `Match ${references.page} and ${references.frame}`;
  const panel = await opened(page, component);
  await panel.getByRole('button', { name: 'Ask AI' }).click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${component.file}` });
  await prompt.getByRole('textbox', { name: 'Describe the change' }).fill(request);
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
    timeout: READY_MS,
  });
  const run = (await cliRuns(log)).find((entry) => entry.request === request);
  expect(run?.links?.map((link) => link.url)).toEqual([references.page]);
  expect(run?.figma?.map((frame) => frame.node)).toEqual(['12:34']);
  await variants.getByRole('button', { name: 'Discard' }).click();
}
