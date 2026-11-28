import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
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
  replaceOnce,
  startFixtureServer,
} from './support/fixture.js';

const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const BUTTON_FILE = 'src/components/OrderButton.tsx';
const BASE = 'rounded-lg bg-brand px-6 py-3 font-medium text-white';
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const GIFT = 'Gift cards for every occasion';

let fixture: FixtureServer;
let original: string;

function withBase(classes: string): string {
  return replaceOnce(original, `className="${BASE}"`, `className="${classes}"`);
}

async function withClasses(classes: string) {
  await writeFile(ORDER_BUTTON, withBase(classes));
  await expect
    .poll(async () =>
      (await fetch(new URL(relative(FIXTURE_DIR, ORDER_BUTTON), fixture.url))).text(),
    )
    .toContain(classes);
}

async function selectButton(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  await page.getByRole('button', { name: 'Order now' }).click();
  const panel = page.getByRole('dialog', { name: `Fine-tune ${BUTTON_FILE}` });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
}

function section(panel: Locator, name: string) {
  return panel.getByRole('region', { name, exact: true });
}

function guard(panel: Locator, name: string, token: string) {
  return section(panel, name).getByText(`At this width, ${token} sets this.`);
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  original = await readFile(ORDER_BUTTON, 'utf8');
  expect(original, 'OrderButton.tsx must start from its committed classes').toContain(
    `className="${BASE}"`,
  );
  await waitForDaemon(widgetRequests(fixture.api), { file: BUTTON_FILE, line: 3, column: 5 });
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('on a phone the base class wins, so padding stays editable and writes the base', async ({
  page,
}) => {
  await withClasses(`${BASE} md:pb-6`);
  const panel = await selectButton(page, MOBILE);

  await expect(guard(panel, 'Layout', 'md:pb-6')).toHaveCount(0);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  await expect(bottom).toHaveAttribute('aria-valuetext', '12 · pb-3');
  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS('padding-bottom', '16px');
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible();

  const written = await readFile(ORDER_BUTTON, 'utf8');
  expect(written).toContain('pb-4');
  expect(written).toContain('md:pb-6');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(ORDER_BUTTON, 'utf8')).toBe(withBase(`${BASE} md:pb-6`));
});

test('on a desktop md: wins, so the section explains and its handle is not drawn', async ({
  page,
}) => {
  await withClasses(`${BASE} md:pb-6`);
  const panel = await selectButton(page, DESKTOP);

  await expect(guard(panel, 'Layout', 'md:pb-6')).toBeVisible();
  await expect(section(panel, 'Layout')).toContainText('Change it in your code or with Ask AI.');
  await expect(page.getByRole('slider', { name: 'Padding bottom' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Padding top' })).toHaveCount(1);
  await expect(section(panel, 'Fill').getByText('At this width')).toHaveCount(0);
  expect((await section(panel, 'Layout').textContent()) ?? '').not.toMatch(/[–—]/);
});

test('resizing with the panel open moves between editable and explained', async ({ page }) => {
  await withClasses(`${BASE} md:pb-6`);
  const panel = await selectButton(page, MOBILE);
  await expect(page.getByRole('slider', { name: 'Padding bottom' })).toHaveCount(1);

  await page.setViewportSize(DESKTOP);
  await expect(guard(panel, 'Layout', 'md:pb-6')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Padding bottom' })).toHaveCount(0);

  await page.setViewportSize(MOBILE);
  await expect(guard(panel, 'Layout', 'md:pb-6')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Padding bottom' })).toHaveCount(1);
});

for (const [name, classes, size, token, group] of [
  ['max-md: guards on a phone', `${BASE} max-md:pb-6`, MOBILE, 'max-md:pb-6', 'Layout'],
  [
    'an arbitrary min width guards above it',
    `${BASE} min-[900px]:pb-6`,
    DESKTOP,
    'min-[900px]:pb-6',
    'Layout',
  ],
  ['a responsive text size guards Text', `${BASE} md:text-lg`, DESKTOP, 'md:text-lg', 'Text'],
] as const) {
  test(`${name}`, async ({ page }) => {
    await withClasses(classes);
    const panel = await selectButton(page, size);

    await expect(guard(panel, group, token)).toBeVisible();
  });
}

for (const [name, classes, size, token, group] of [
  ['max-md: leaves a desktop editable', `${BASE} max-md:pb-6`, DESKTOP, 'max-md:pb-6', 'Layout'],
  [
    'an arbitrary min width leaves smaller screens editable',
    `${BASE} min-[900px]:pb-6`,
    MOBILE,
    'min-[900px]:pb-6',
    'Layout',
  ],
  [
    'hover: never guards',
    'rounded-lg bg-brand hover:bg-espresso px-6 py-3 font-medium text-white',
    DESKTOP,
    'hover:bg-espresso',
    'Fill',
  ],
] as const) {
  test(`${name}`, async ({ page }) => {
    await withClasses(classes);
    const panel = await selectButton(page, size);

    await expect(section(panel, group).getByText('At this width')).toHaveCount(0);
    await expect(guard(panel, group, token)).toHaveCount(0);
  });
}

test('dark: guards only in dark mode', async ({ page }) => {
  await withClasses('rounded-lg bg-brand dark:bg-espresso px-6 py-3 font-medium text-white');
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await selectButton(page, DESKTOP);
  await expect(guard(dark, 'Fill', 'dark:bg-espresso')).toBeVisible();

  await page.emulateMedia({ colorScheme: 'light' });
  const light = await selectButton(page, DESKTOP);
  await expect(section(light, 'Fill').getByText('At this width')).toHaveCount(0);
});

test('Copy style skips a group a breakpoint class sets on the target', async ({ page }) => {
  await withClasses(`${BASE} md:pb-6`);
  await page.setViewportSize(DESKTOP);
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  await page.getByText(GIFT).click();
  const gift = page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });
  await expect(gift.getByText('Reading the element…')).toHaveCount(0);
  await gift.getByRole('button', { name: 'Copy style' }).click();

  await page.getByRole('button', { name: 'Order now' }).click();

  const target = page.getByRole('dialog', { name: `Fine-tune ${BUTTON_FILE}` });
  await expect(target.getByText('Unsaved')).toBeVisible();
  await target.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible();
  const written = await readFile(ORDER_BUTTON, 'utf8');
  expect(written).toContain('md:pb-6');
  expect(written).not.toMatch(/\bpb-4\b/);
  expect(written).toMatch(/bg-\[#fde68a\]/i);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(ORDER_BUTTON, 'utf8')).toBe(withBase(`${BASE} md:pb-6`));
  await page
    .getByRole('region', { name: 'Paste style' })
    .getByRole('button', { name: 'Stop' })
    .click();
});
