import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type AstroServer, startAstro } from './support/astro.js';
import { GJD_BINARY, requireDaemonBinary, stopDaemon } from './support/daemon.js';
import { openSection } from './support/finetune.js';
import { openFixture } from './support/fixture.js';
import {
  dragPadding,
  dragPanel,
  editFoundText,
  editText,
  hideAndShowSketch,
  jiraLoop,
  pasteStyle,
  pickThemeColor,
  promptForTwo,
  sketchWithUndo,
} from './support/new-features.js';
import { searchPath } from './support/process.js';
import { type References, startReferences } from './support/references.js';
import {
  collapsedPanel,
  historyRoundTrip,
  linksAndFigma,
  styleGroups,
} from './support/release-qa.js';

const ASTRO_DIR = fileURLToPath(new URL('../../fixtures/small-astro-tailwind4/', import.meta.url));
const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const EXTRAS = join(ASTRO_DIR, 'src/components/Extras.astro');
const ORDER_BUTTON = join(ASTRO_DIR, 'src/components/OrderButton.astro');
const INDEX = join(ASTRO_DIR, 'src/pages/index.astro');
const TALLY = join(ASTRO_DIR, 'src/components/Tally.tsx');
const BLUE_RGB = 'rgb(29, 78, 216)';
const BRAND_RGB = 'rgb(190, 18, 60)';
const LIGHT_BLUE_RGB = 'rgb(37, 99, 235)';
const AMBER_RGB = 'rgb(253, 230, 138)';
const ESPRESSO_RGB = 'rgb(59, 36, 24)';

test.describe.configure({ timeout: 90_000 });

let astro: AstroServer;
let references: References;
let workDir: string;
const originals = new Map<string, string>();
const savedPath = process.env.PATH;

async function chooseTool(page: Page, name: 'Select' | 'Draw'): Promise<void> {
  const tool = page.getByRole('toolbar', { name: 'GUIJam' }).getByRole('button', { name });
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

async function pick(page: Page, element: Locator, file: string): Promise<Locator> {
  await element.click();
  const panel = page.getByRole('dialog', { name: `Fine-tune ${file}` });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
}

async function mark(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as { gjMarker?: boolean }).gjMarker = true;
  });
}

async function marked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as { gjMarker?: boolean }).gjMarker === true);
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

test.beforeAll(async () => {
  await requireDaemonBinary();
  references = await startReferences();
  await stopDaemon(ASTRO_DIR);
  workDir = await mkdtemp(join(tmpdir(), 'guijam-astro-'));
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = join(workDir, 'runs.jsonl');
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedPath);
  for (const file of [ORDER_BUTTON, INDEX, TALLY]) {
    originals.set(file, await readFile(file, 'utf8'));
  }
  astro = await startAstro(ASTRO_DIR);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
  for (const [file, content] of originals) {
    if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
  }
});

test.afterAll(async () => {
  await references?.stop();
  await astro?.stop();
  await stopDaemon(ASTRO_DIR);
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedPath;
  await rm(workDir, { recursive: true, force: true });
});

test('astro templates and islands carry source locations and boot the toolbar', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openFixture(page, astro.url);

  await expect(page.getByRole('button', { name: 'Order now' })).toHaveAttribute(
    'data-gj-src',
    'src/components/OrderButton.astro:4:1',
  );
  await expect(page.getByText('Gift cards for every occasion')).toHaveAttribute(
    'data-gj-src',
    'src/pages/index.astro:21:7',
  );
  await expect(page.getByRole('button', { name: /Cups today/ })).toHaveAttribute(
    'data-gj-src',
    'src/components/Tally.tsx:6:5',
  );
  await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('fine-tuning an astro template previews in the page, applies without a reload and undoes', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await mark(page);
  const button = page.getByRole('button', { name: 'Order now' });
  const panel = await pick(page, button, 'src/components/OrderButton.astro');
  const fill = await openSection(panel, 'Fill');
  await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('BE123C');
  const before = await readFile(ORDER_BUTTON, 'utf8');

  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');

  await expect(button).toHaveCSS('background-color', BLUE_RGB);
  await expect(button).toHaveClass(/bg-\[#1D4ED8\]/);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Applied to OrderButton.astro.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(
    before.replace('rounded-lg bg-brand px-6', 'rounded-lg bg-[#1D4ED8] px-6'),
  );
  await page.waitForTimeout(1_500);
  expect(await marked(page)).toBe(true);
  await expect(button).toHaveCSS('background-color', BLUE_RGB);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(ORDER_BUTTON, 'utf8')).toBe(before);
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS(
    'background-color',
    BRAND_RGB,
  );
});

test('an inline style in an astro page previews in place and closing restores it', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await mark(page);
  const gift = page.getByText('Gift cards for every occasion');
  const style = await gift.getAttribute('style');
  let panel = await pick(page, gift, 'src/pages/index.astro');
  const hex = () =>
    panel.getByRole('region', { name: 'Fill' }).getByRole('textbox', { name: 'Fill hex' });
  await openSection(panel, 'Fill');
  await expect(hex()).toHaveValue('FDE68A');
  const before = await readFile(INDEX, 'utf8');

  await hex().fill('1d4ed8');
  await expect(gift).toHaveCSS('background-color', BLUE_RGB);
  await panel.getByRole('button', { name: 'Close' }).click();

  await expect(page.getByRole('status')).toContainText('Unsaved tweaks were reverted.');
  await expect(gift).toHaveCSS('background-color', AMBER_RGB);
  expect(await gift.getAttribute('style')).toBe(style);
  expect(await readFile(INDEX, 'utf8')).toBe(before);

  panel = await pick(page, gift, 'src/pages/index.astro');
  await hex().fill('1d4ed8');
  await expect(gift).toHaveCSS('background-color', BLUE_RGB);
  await panel.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByRole('status')).toContainText('Applied to index.astro.');
  expect(await readFile(INDEX, 'utf8')).toBe(
    before.replace('background-color: #fde68a', 'background-color: #1D4ED8'),
  );
  expect(await marked(page)).toBe(true);
});

test('a react island inside astro previews through hot reload', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await mark(page);
  const tally = page.getByRole('button', { name: /Cups today/ });
  const panel = await pick(page, tally, 'src/components/Tally.tsx');
  const fill = await openSection(panel, 'Fill');

  await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');
  await expect(tally).toHaveCSS('background-color', BLUE_RGB);
  await panel.getByRole('button', { name: 'Close' }).click();

  await expect(tally).toHaveCSS('background-color', ESPRESSO_RGB);
  expect(await marked(page)).toBe(true);
  expect(await readFile(TALLY, 'utf8')).toBe(originals.get(TALLY));
});

test('a drawn prompt previews an astro variant through a reload and Use writes it', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Draw');
  const button = page.getByRole('button', { name: 'Order now' });
  await circle(page, button);
  const prompt = page.getByRole('dialog', { name: 'Ask AI src/components/OrderButton.astro' });
  await prompt
    .getByRole('textbox', { name: 'Describe the change' })
    .fill('Make it feel more premium');
  await prompt.getByRole('button', { name: 'Generate' }).click();

  const variants = prompt.getByRole('region', { name: 'Variants' });
  await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS(
    'background-color',
    LIGHT_BLUE_RGB,
  );
  const before = await readFile(ORDER_BUTTON, 'utf8');
  expect(before).toContain('bg-brand');

  await variants.getByRole('button', { name: 'Use V1' }).click();

  await expect(page.getByRole('status')).toContainText('Applied to OrderButton.astro.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.replace('bg-brand', 'bg-[#2563EB]'));
});

test('Shift+click puts two components in one prompt, and Use and Undo cover both files', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await promptForTwo(
    page,
    {
      element: page.getByRole('button', { name: 'Order now' }),
      file: 'src/components/OrderButton.astro',
      path: ORDER_BUTTON,
    },
    {
      element: page.getByRole('heading', { level: 1 }),
      file: 'src/pages/index.astro',
      path: INDEX,
    },
  );
});

test('a sketch over a component undoes and redoes strokes, then generates', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await sketchWithUndo(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});

test('the eye beside Close hides and shows a sketch over its variants, through a reload', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await hideAndShowSketch(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});

test('a panel is dragged by its header, hands its spot to Ask AI and resets', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await dragPanel(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});

test('the h1 text is edited without AI, previewed, applied and undone', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await editText(page, {
    element: page.getByRole('heading', { level: 1 }),
    file: 'src/pages/index.astro',
    path: INDEX,
  });
});

test('a linked Jira ticket gets the applied change once Undo is gone', async ({ page }) => {
  test.setTimeout(90_000);
  await jiraLoop(
    page,
    {
      element: page.getByRole('heading', { level: 1 }),
      file: 'src/pages/index.astro',
      path: INDEX,
    },
    async () => {
      await openFixture(page, astro.url);
      await chooseTool(page, 'Select');
    },
  );
});

test('a heading rendered from a data array is edited where the array is written', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await editFoundText(page, {
    element: page.locator('#extras h4'),
    file: 'src/components/Extras.astro',
    path: EXTRAS,
    caption: 'From TABS · Extras.astro:3',
  });
});

test('the Fill picker applies a theme color and Undo restores it', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await pickThemeColor(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});
test('dragging a padding handle writes the shorter padding tokens and Undo restores them', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await dragPadding(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});
test('Text, opacity, stroke and a shadow write classes and Undo restores them', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await styleGroups(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});
test('History undoes an older change, keeps the newer one and redoes it', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await historyRoundTrip(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});
test('the panel leads with Ask AI and keeps style sections folded', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await collapsedPanel(page, {
    element: page.getByRole('button', { name: 'Order now' }),
    file: 'src/components/OrderButton.astro',
    path: ORDER_BUTTON,
  });
});
test('a page link and a Figma frame both reach the AI', async ({ page }) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await linksAndFigma(
    page,
    {
      element: page.getByRole('button', { name: 'Order now' }),
      file: 'src/components/OrderButton.astro',
      path: ORDER_BUTTON,
    },
    references,
    process.env.GUIJAM_FAKE_CLAUDE_LOG ?? '',
  );
});
test('Copy style pastes a button style onto an inline-styled paragraph and Undo restores it', async ({
  page,
}) => {
  await openFixture(page, astro.url);
  await chooseTool(page, 'Select');
  await pasteStyle(
    page,
    {
      element: page.getByRole('button', { name: 'Order now' }),
      file: 'src/components/OrderButton.astro',
      path: ORDER_BUTTON,
    },
    {
      element: page.getByText('Gift cards for every occasion'),
      file: 'src/pages/index.astro',
      path: INDEX,
    },
  );
});
