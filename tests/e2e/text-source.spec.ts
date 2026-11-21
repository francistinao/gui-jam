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
  startFixtureServer,
} from './support/fixture.js';

const EXTRAS_FILE = 'src/components/Extras.tsx';
const EXTRAS = fixturePath(EXTRAS_FILE);
const APP = fixturePath('src/App.tsx');
const EN = fixturePath('src/i18n/en.json');
const KO = fixturePath('src/i18n/ko.json');
const READY_MS = 20_000;

let fixture: FixtureServer;
const originals = new Map<string, string>();

function selectTool(page: Page): Locator {
  return page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
}

function drawTool(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name: 'Draw' });
}

function finetune(page: Page, file: string): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${file}` });
}

function field(dialog: Locator): Locator {
  return dialog.getByRole('textbox', { name: 'Text content', exact: true });
}

function applied(page: Page, file: string): Locator {
  return page.getByRole('status').filter({ hasText: `Applied to ${file}.` });
}

function extras(page: Page): Locator {
  return page.locator('#extras');
}

function tabTitle(page: Page): Locator {
  return extras(page).getByRole('heading', { level: 4 });
}

function changedLines(before: string, after: string): string[] {
  const old = before.split('\n');
  return after.split('\n').filter((line, index) => line !== old[index]);
}

async function startSelecting(page: Page): Promise<void> {
  await openFixture(page, fixture.url);
  await selectTool(page).click();
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
}

interface FoundCase {
  element: Locator;
  panel: string;
  caption: string;
  original: string;
  next: string;
  path: string;
  file: string;
  line: string;
}

async function editFound(page: Page, found: FoundCase): Promise<void> {
  const before = await fileSnapshot(found.path);
  await found.element.click();
  const panel = finetune(page, found.panel);
  await expect(field(panel)).toHaveValue(found.original);
  await expect(panel.getByText(found.caption, { exact: true })).toBeVisible();
  await expect(panel.getByText('Use Ask AI to change it.', { exact: false })).toHaveCount(0);

  await field(panel).fill(found.next);

  await expect(found.element).toHaveText(found.next, { timeout: READY_MS });
  expect(await fileSnapshot(found.path)).toEqual(before);
  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = applied(page, found.file);
  await expect(toast).toBeVisible();
  expect(changedLines(before.content, await readFile(found.path, 'utf8'))).toEqual([found.line]);
  await expect(field(panel)).toHaveValue(found.next);

  await toast.getByRole('button', { name: 'Undo' }).click();

  await expect.poll(() => readFile(found.path, 'utf8')).toBe(before.content);
  await expect(found.element).toHaveText(found.original, { timeout: READY_MS });
  await expect(field(panel)).toHaveValue(found.original);
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  for (const file of [EXTRAS, APP, EN, KO]) originals.set(file, await readFile(file, 'utf8'));
  await waitForDaemon(widgetRequests(fixture.api), { file: EXTRAS_FILE, line: 36, column: 7 });
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

test('a heading rendered from a data array edits the string in the array', async ({ page }) => {
  await startSelecting(page);
  await editFound(page, {
    element: tabTitle(page),
    panel: EXTRAS_FILE,
    caption: 'From TABS · Extras.tsx:7',
    original: 'CBPLD Overview',
    next: `Bob's "Overview" & more`,
    path: EXTRAS,
    file: 'Extras.tsx',
    line: `  { id: 'overview', title: 'Bob\\'s "Overview" & more' },`,
  });
});

test('one card of a list edits only its own item where the list is written', async ({ page }) => {
  await startSelecting(page);
  const others = [
    page.getByRole('heading', { name: 'Spanish Latte' }),
    page.getByRole('heading', { name: 'Ube Cheese Pandesal' }),
  ];
  await page.getByRole('heading', { name: 'Ensaymada' }).click();
  await expect(finetune(page, 'src/components/MenuCard.tsx').getByRole('note')).toHaveText(
    'Used 3× on this page. Style changes apply to every instance.',
  );
  await page.keyboard.press('Escape');
  await editFound(page, {
    element: page.getByRole('heading', { name: /Ensaymada$/ }),
    panel: 'src/components/MenuCard.tsx',
    caption: 'From MENU · App.tsx:12',
    original: 'Ensaymada',
    next: 'Ube Ensaymada',
    path: APP,
    file: 'App.tsx',
    line: "  { name: 'Ube Ensaymada', description: 'Buttery brioche with queso and sugar', price: 95 },",
  });
  for (const other of others) await expect(other).toBeVisible();
});

test('children and a prop are edited where the component is used', async ({ page }) => {
  await startSelecting(page);
  await editFound(page, {
    element: extras(page).getByText(/^Fresh/),
    panel: 'src/components/Badge.tsx',
    caption: 'From <Badge> · Extras.tsx:37',
    original: 'Fresh today',
    next: 'Fresh & hot <now>',
    path: EXTRAS,
    file: 'Extras.tsx',
    line: '      <Badge>Fresh &amp; hot &lt;now&gt;</Badge>',
  });
  await editFound(page, {
    element: extras(page).getByText(/^Open (daily|"daily")$/),
    panel: 'src/components/Note.tsx',
    caption: 'From <Note title> · Extras.tsx:38',
    original: 'Open daily',
    next: 'Open "daily"',
    path: EXTRAS,
    file: 'Extras.tsx',
    line: '      <Note title="Open &quot;daily&quot;" />',
  });
});

test('a translated string is edited in the language the page shows', async ({ page }) => {
  await startSelecting(page);
  const korean = await fileSnapshot(KO);
  await editFound(page, {
    element: extras(page).getByText(/^Open \d/),
    panel: EXTRAS_FILE,
    caption: 'From footer.hours · en.json:3',
    original: 'Open 7 to 7, every day',
    next: 'Open 6 to 9 "daily"',
    path: EN,
    file: 'en.json',
    line: '    "hours": "Open 6 to 9 \\"daily\\""',
  });
  expect(await fileSnapshot(KO)).toEqual(korean);
});

test('text written in two places asks where to edit before the field opens', async ({ page }) => {
  await startSelecting(page);
  const before = await fileSnapshot(EXTRAS);
  const plan = extras(page)
    .getByText(/^Barista Club/)
    .first();
  const upsell = extras(page)
    .getByText(/^Barista Club/)
    .last();
  await plan.click();
  const panel = finetune(page, EXTRAS_FILE);
  const where = panel.getByRole('combobox', { name: 'Where to edit' });
  await expect(where).toBeVisible();
  await expect(where.getByRole('option')).toHaveText([
    'Written in 2 places. Choose one',
    'PLAN · Extras.tsx:11',
    'UPSELL · Extras.tsx:12',
  ]);
  await expect(field(panel)).toBeDisabled();

  await where.selectOption({ label: 'PLAN · Extras.tsx:11' });
  await expect(field(panel)).toBeEnabled();
  await expect(panel.getByText('From PLAN · Extras.tsx:11', { exact: true })).toBeVisible();
  await field(panel).fill('Barista Club Plus');

  await expect(plan).toHaveText('Barista Club Plus', { timeout: READY_MS });
  await expect(upsell).toHaveText('Barista Club');
  await panel.getByRole('button', { name: 'Apply' }).click();

  const toast = applied(page, 'Extras.tsx');
  await expect(toast).toBeVisible();
  expect(changedLines(before.content, await readFile(EXTRAS, 'utf8'))).toEqual([
    "const PLAN = { name: 'Barista Club Plus' };",
  ]);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(EXTRAS, 'utf8')).toBe(before.content);
});

test('Revert and Esc leave the data file untouched', async ({ page }) => {
  await startSelecting(page);
  const before = await fileSnapshot(EXTRAS);
  const heading = tabTitle(page);
  await heading.click();
  const panel = finetune(page, EXTRAS_FILE);
  await field(panel).fill('Something else');
  await expect(heading).toHaveText('Something else', { timeout: READY_MS });

  await page.keyboard.press('Escape');

  await expect(
    page.getByRole('status').filter({ hasText: 'Unsaved tweaks were reverted.' }),
  ).toBeVisible();
  await expect(heading).toHaveText('CBPLD Overview', { timeout: READY_MS });
  expect(await fileSnapshot(EXTRAS)).toEqual(before);
});

test('a Draw circle around data-driven text applies it with Apply text', async ({ page }) => {
  await openFixture(page, fixture.url);
  const heading = tabTitle(page);
  await heading.scrollIntoViewIfNeeded();
  await drawTool(page).click();
  const before = await fileSnapshot(EXTRAS);
  const box = await heading.boundingBox();
  if (!box) throw new Error('the heading is not visible');
  const left = box.x - 12;
  const right = box.x + box.width + 12;
  const top = box.y - 10;
  const bottom = box.y + box.height + 10;
  await page.mouse.move(left, top + 8);
  await page.mouse.down();
  for (const [x, y] of [
    [left + 30, top],
    [right, top + 4],
    [right - 4, bottom],
    [left + 6, bottom - 2],
    [left, top + 12],
  ] as const) {
    await page.mouse.move(x, y, { steps: 6 });
  }
  await page.mouse.up();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${EXTRAS_FILE}` });
  await expect(field(prompt)).toHaveValue('CBPLD Overview');
  await expect(prompt.getByText('From TABS · Extras.tsx:7', { exact: true })).toBeVisible();

  await field(prompt).fill('Quarterly Overview');
  await expect(heading).toHaveText('Quarterly Overview', { timeout: READY_MS });
  await prompt.getByRole('button', { name: 'Apply text' }).click();

  const toast = applied(page, 'Extras.tsx');
  await expect(toast).toBeVisible();
  expect(changedLines(before.content, await readFile(EXTRAS, 'utf8'))).toEqual([
    "  { id: 'overview', title: 'Quarterly Overview' },",
  ]);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(EXTRAS, 'utf8')).toBe(before.content);
});
