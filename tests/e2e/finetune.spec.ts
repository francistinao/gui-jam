import { readFile, writeFile } from 'node:fs/promises';
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
  replaceOnce,
  startFixtureServer,
} from './support/fixture.js';

const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const APP = fixturePath('src/App.tsx');
const TOUCHED = [
  ORDER_BUTTON,
  APP,
  fixturePath('src/components/Counter.tsx'),
  fixturePath('src/components/MenuCard.tsx'),
];
const BRAND_RGB = 'rgb(190, 18, 60)';
const ESPRESSO_RGB = 'rgb(59, 36, 24)';
const BLUE_RGB = 'rgb(29, 78, 216)';

let fixture: FixtureServer;
const originals = new Map<string, string>();

function changedLines(before: string, after: string): string[] {
  const afterLines = after.split('\n');
  return before
    .split('\n')
    .flatMap((line, index) =>
      line === afterLines[index] ? [] : [`${line} → ${afterLines[index]}`],
    );
}

async function startSelecting(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  const select = page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' });
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
}

async function pick(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  const panel = page.getByRole('dialog', { name: `Fine-tune ${file}` });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  for (const file of TOUCHED) originals.set(file, await readFile(file, 'utf8'));
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
    line: 3,
    column: 5,
  });
});

test.afterEach(async () => {
  for (const [file, content] of originals) {
    if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
  }
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('fine-tunes a fill live, applies one line, and undo restores the exact bytes', async ({
  page,
}) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const panel = await pick(page, button, 'src/components/OrderButton.tsx');
  const fill = panel.getByRole('region', { name: 'Fill' });
  const radius = panel.getByRole('region', { name: 'Radius' });

  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('BE123C');
  await expect(fill.getByRole('button', { name: 'Fill brand' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(radius.getByRole('button', { name: 'Radius lg' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const text = panel.getByRole('region', { name: 'Text' });
  await expect(text.getByRole('combobox', { name: 'Font weight' })).toHaveValue('500');
  await expect(text).toContainText('white');
  await expect(
    panel.getByRole('region', { name: 'Stroke' }).getByRole('button', { name: 'Add stroke' }),
  ).toBeVisible();

  const before = await fileSnapshot(ORDER_BUTTON);
  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');

  await expect(button).toHaveCSS('background-color', BLUE_RGB);
  const apply = panel.getByRole('button', { name: 'Apply' });
  await expect(apply).toBeEnabled();
  await panel.getByRole('tab', { name: 'Code' }).click();
  const code = panel.getByRole('tabpanel', { name: 'Code' });
  await expect(code.locator('pre')).toHaveCount(1);
  await expect(code).toContainText('3 - <button type="button" className="rounded-lg bg-brand');
  await expect(code).toContainText('3 + <button type="button" className="rounded-lg bg-[#1D4ED8]');
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  await apply.click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Applied to OrderButton.tsx.');
  const written = await readFile(ORDER_BUTTON, 'utf8');
  expect(changedLines(before.content, written)).toEqual([
    expect.stringContaining('bg-brand px-6 py-3 font-medium text-white"> → '),
  ]);
  expect(written).toContain('className="rounded-lg bg-[#1D4ED8] px-6 py-3 font-medium text-white"');
  await expect(button).toHaveCSS('background-color', BLUE_RGB);
  await panel.getByRole('tab', { name: 'Design' }).click();
  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('1D4ED8');
  await expect(fill.getByRole('button', { name: 'Fill brand' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Change undone.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.content);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('BE123C');
  await expect(fill.getByRole('button', { name: 'Fill brand' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('opens the stroke and text editors from the source, and the click never reaches the page', async ({
  page,
}) => {
  await startSelecting(page);
  const counter = page.getByRole('button', { name: /Cups ordered/ });
  const panel = await pick(page, counter, 'src/components/Counter.tsx');

  const stroke = panel.getByRole('region', { name: 'Stroke' });
  await expect(stroke).toContainText('espresso');
  await expect(stroke.getByLabel('Stroke width')).toHaveValue('1');
  await expect(panel.getByRole('region', { name: 'Text' })).toContainText('font-semibold');
  await expect(
    panel.getByRole('region', { name: 'Fill' }).getByRole('button', { name: 'Add fill' }),
  ).toBeVisible();
  await expect(counter).toHaveText('Cups ordered: 0');
});

test('edits every instance of a repeated element, and closing reverts unsaved tweaks', async ({
  page,
}) => {
  await startSelecting(page);
  const addButtons = page.getByRole('button', { name: 'Add', exact: true });
  await expect(addButtons).toHaveCount(3);
  const panel = await pick(page, addButtons.first(), 'src/components/MenuCard.tsx');
  const menuCard = await fileSnapshot(fixturePath('src/components/MenuCard.tsx'));

  await expect(panel.getByRole('note')).toHaveText(
    'Used 3× on this page. Changes apply to every instance.',
  );
  await panel.getByRole('textbox', { name: 'Fill hex' }).fill('1D4ED8');
  for (const add of await addButtons.all())
    await expect(add).toHaveCSS('background-color', BLUE_RGB);
  await expect(panel.getByRole('button', { name: 'Apply' })).toBeEnabled();

  await panel.getByRole('button', { name: 'Close' }).click();

  await expect(page.getByRole('status')).toContainText('Unsaved tweaks were reverted.');
  await expect(panel).toHaveCount(0);
  for (const add of await addButtons.all())
    await expect(add).toHaveCSS('background-color', ESPRESSO_RGB);
  expect(await fileSnapshot(fixturePath('src/components/MenuCard.tsx'))).toEqual(menuCard);
});

test('refuses to apply over a developer edit made after the preview', async ({ page }) => {
  await startSelecting(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const panel = await pick(page, button, 'src/components/OrderButton.tsx');
  await panel.getByRole('textbox', { name: 'Fill hex' }).fill('1D4ED8');
  await expect(panel.getByRole('button', { name: 'Apply' })).toBeEnabled();
  const developerVersion = replaceOnce(originals.get(ORDER_BUTTON) ?? '', 'px-6', 'px-8');
  await writeFile(ORDER_BUTTON, developerVersion);

  await panel.getByRole('button', { name: 'Apply' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'src/components/OrderButton.tsx changed on disk since this change was made',
  );
  await expect(alert).toContainText('Review them, then preview again.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(developerVersion);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});

test('an element with an inline style is fine-tuned in its style object', async ({ page }) => {
  await startSelecting(page);
  const gift = page.getByText('Gift cards for every occasion');
  const panel = await pick(page, gift, 'src/App.tsx');
  const fill = panel.getByRole('region', { name: 'Fill' });
  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('FDE68A');
  const before = await readFile(APP, 'utf8');

  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');
  await panel
    .getByRole('region', { name: 'Radius' })
    .getByRole('button', { name: 'Radius full' })
    .click();

  await expect(gift).toHaveCSS('background-color', BLUE_RGB);
  await expect(gift).toHaveCSS('border-top-left-radius', '9999px');
  await panel.getByRole('tab', { name: 'Code' }).click();
  const code = panel.getByRole('tabpanel', { name: 'Code' });
  await expect(code).toContainText(
    '48 + <p className="mt-6" style={{ backgroundColor: \'#1D4ED8\', borderRadius: 9999, padding: 16 }}>',
  );
  expect(await readFile(APP, 'utf8')).toBe(before);

  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = page.getByRole('status');
  await expect(toast).toContainText('Applied to App.tsx.');
  expect(changedLines(before, await readFile(APP, 'utf8'))).toEqual([
    expect.stringContaining("backgroundColor: '#1D4ED8', borderRadius: 9999, padding: 16 }}>"),
  ]);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Change undone.');
  expect(await readFile(APP, 'utf8')).toBe(before);
});
