import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { GJD_BINARY, requireDaemonBinary, stopDaemon } from './support/daemon.js';
import { openSection } from './support/finetune.js';
import {
  dragPadding,
  dragPanel,
  editFoundText,
  editText,
  hideAndShowSketch,
  jiraLoop,
  pickThemeColor,
  promptForTwo,
  sketchWithUndo,
} from './support/new-features.js';
import { type Bundler, type NextServer, startNext } from './support/next.js';
import { searchPath } from './support/process.js';

const NEXT_DIR = fileURLToPath(new URL('../../fixtures/small-next-tailwind4/', import.meta.url));
const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const EXTRAS = join(NEXT_DIR, 'app/components/Extras.tsx');
const ORDER_BUTTON = join(NEXT_DIR, 'app/components/OrderButton.tsx');
const PAGE = join(NEXT_DIR, 'app/page.tsx');
const BLUE_RGB = 'rgb(29, 78, 216)';
const BRAND_RGB = 'rgb(190, 18, 60)';
const LIGHT_BLUE_RGB = 'rgb(37, 99, 235)';
const BUNDLERS: readonly Bundler[] = ['turbopack', 'webpack'];

test.describe.configure({ timeout: 120_000 });

const savedPath = process.env.PATH;
const originals = new Map<string, string>();

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    (window as { gjMarker?: boolean }).gjMarker = true;
  });
}

async function marked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as { gjMarker?: boolean }).gjMarker === true);
}

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

for (const bundler of BUNDLERS) {
  test.describe(`next.js with ${bundler}`, () => {
    let next: NextServer;
    let workDir: string;

    test.beforeAll(async () => {
      await requireDaemonBinary();
      await stopDaemon(NEXT_DIR);
      workDir = await mkdtemp(join(tmpdir(), `guijam-next-${bundler}-`));
      process.env.GUIJAM_GJD_BIN = GJD_BINARY;
      process.env.GUIJAM_FAKE_CLAUDE_LOG = join(workDir, 'runs.jsonl');
      process.env.PATH = searchPath(FAKE_CLI_DIR, savedPath);
      for (const file of [ORDER_BUTTON, PAGE]) originals.set(file, await readFile(file, 'utf8'));
      await rm(join(NEXT_DIR, '.next'), { recursive: true, force: true });
      next = await startNext(NEXT_DIR, bundler);
    });

    test.afterEach(async ({ page }) => {
      await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
      for (const [file, content] of originals) {
        if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
      }
    });

    test.afterAll(async () => {
      await next?.stop();
      await stopDaemon(NEXT_DIR);
      delete process.env.GUIJAM_GJD_BIN;
      delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
      process.env.PATH = savedPath;
      await rm(workDir, { recursive: true, force: true });
    });

    test('server and client components carry source locations and the toolbar boots', async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await open(page, next.url);

      await expect(page.getByRole('button', { name: 'Order now' })).toHaveAttribute(
        'data-gj-src',
        'app/components/OrderButton.tsx:5:5',
      );
      await expect(page.getByText('Gift cards for every occasion')).toHaveAttribute(
        'data-gj-src',
        'app/page.tsx:22:11',
      );
      await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS(
        'background-color',
        BRAND_RGB,
      );
      expect(errors).toEqual([]);
    });

    test('fine-tuning a client component previews live, applies and undoes', async ({ page }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      const button = page.getByRole('button', { name: 'Order now' });
      const panel = await pick(page, button, 'app/components/OrderButton.tsx');
      const fill = await openSection(panel, 'Fill');
      await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('BE123C');
      const before = await readFile(ORDER_BUTTON, 'utf8');

      await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');

      await expect(button).toHaveCSS('background-color', BLUE_RGB, { timeout: 20_000 });
      expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
      await panel.getByRole('button', { name: 'Apply' }).click();
      const toast = page.getByRole('status');
      await expect(toast).toContainText('Applied to OrderButton.tsx.');
      expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(
        before.replace('rounded-lg bg-brand px-6', 'rounded-lg bg-[#1D4ED8] px-6'),
      );
      await expect(button).toHaveCSS('background-color', BLUE_RGB);

      await toast.getByRole('button', { name: 'Undo' }).click();
      await expect(toast).toContainText('Change undone.');
      expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
      await expect(button).toHaveCSS('background-color', BRAND_RGB, { timeout: 20_000 });
      expect(await marked(page)).toBe(true);
    });

    test('a server component style object previews and applies', async ({ page }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      const gift = page.getByText('Gift cards for every occasion');
      const panel = await pick(page, gift, 'app/page.tsx');
      const fill = await openSection(panel, 'Fill');
      await expect(fill.getByRole('textbox', { name: 'Fill hex' })).toHaveValue('FDE68A');
      const before = await readFile(PAGE, 'utf8');

      await fill.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');
      await expect(gift).toHaveCSS('background-color', BLUE_RGB, { timeout: 20_000 });
      await panel.getByRole('button', { name: 'Apply' }).click();

      await expect(page.getByRole('status')).toContainText('Applied to page.tsx.');
      expect(await readFile(PAGE, 'utf8')).toBe(
        before.replace("backgroundColor: '#fde68a'", "backgroundColor: '#1D4ED8'"),
      );
      expect(await marked(page)).toBe(true);
    });

    test('a drawn prompt previews a variant and Use writes it', async ({ page }) => {
      await open(page, next.url);
      await chooseTool(page, 'Draw');
      const button = page.getByRole('button', { name: 'Order now' });
      await circle(page, button);
      const prompt = page.getByRole('dialog', { name: 'Ask AI app/components/OrderButton.tsx' });
      await prompt
        .getByRole('textbox', { name: 'Describe the change' })
        .fill('Make it feel more premium');
      await prompt.getByRole('button', { name: 'Generate' }).click();

      const variants = prompt.getByRole('region', { name: 'Variants' });
      await expect(variants.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
        timeout: 30_000,
      });
      await expect(button).toHaveCSS('background-color', LIGHT_BLUE_RGB, { timeout: 20_000 });
      const before = await readFile(ORDER_BUTTON, 'utf8');
      expect(before).toContain('bg-brand');

      await variants.getByRole('button', { name: 'Use V1' }).click();

      await expect(page.getByRole('status')).toContainText('Applied to OrderButton.tsx.');
      expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before.replace('bg-brand', 'bg-[#2563EB]'));
    });

    test('Shift+click puts two components in one prompt, and Use and Undo cover both files', async ({
      page,
    }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await promptForTwo(
        page,
        {
          element: page.getByRole('button', { name: 'Order now' }),
          file: 'app/components/OrderButton.tsx',
          path: ORDER_BUTTON,
        },
        { element: page.getByRole('heading', { level: 1 }), file: 'app/page.tsx', path: PAGE },
      );
    });

    test('a sketch over a component undoes and redoes strokes, then generates', async ({
      page,
    }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await sketchWithUndo(page, {
        element: page.getByRole('button', { name: 'Order now' }),
        file: 'app/components/OrderButton.tsx',
        path: ORDER_BUTTON,
      });
    });

    test('the eye beside Close hides and shows a sketch over its variants, through a reload', async ({
      page,
    }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await hideAndShowSketch(page, {
        element: page.getByRole('button', { name: 'Order now' }),
        file: 'app/components/OrderButton.tsx',
        path: ORDER_BUTTON,
      });
    });

    test('a panel is dragged by its header, hands its spot to Ask AI and resets', async ({
      page,
    }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await dragPanel(page, {
        element: page.getByRole('button', { name: 'Order now' }),
        file: 'app/components/OrderButton.tsx',
        path: ORDER_BUTTON,
      });
    });

    test('a variant hot reload cannot swap, reopened from another page, loads the page once and settles', async ({
      page,
    }) => {
      const original = originals.get(ORDER_BUTTON) ?? '';
      await writeFile(ORDER_BUTTON, `${original}\nexport const ORDER_SAMPLES = ['Order now'];\n`);
      await open(page, next.url);
      await chooseTool(page, 'Draw');
      await circle(page, page.getByRole('button', { name: 'Order now' }));
      const prompt = page.getByRole('dialog', { name: 'Ask AI app/components/OrderButton.tsx' });
      await prompt
        .getByRole('textbox', { name: 'Describe the change' })
        .fill('Make it feel more premium');
      await prompt.getByRole('button', { name: 'Generate' }).click();
      let settling = 0;
      page.on('load', () => {
        settling += 1;
      });
      await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(5_000);
      expect(settling).toBeLessThanOrEqual(1);
      await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
      await page.goto(new URL('menu', next.url).href);
      const away = page.getByRole('button', { name: /^Drawing 1: \d variants?\. Opens \/$/ });
      await expect(away).toBeVisible({ timeout: 60_000 });
      let loads = 0;
      page.on('load', () => {
        loads += 1;
      });

      await away.click();

      await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(10_000);
      expect(loads).toBeLessThanOrEqual(3);
      await expect(prompt.getByRole('group', { name: 'Pick a variant' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS(
        'background-color',
        LIGHT_BLUE_RGB,
      );
      await prompt.getByRole('button', { name: 'Discard' }).click();
    });

    test('the h1 text is edited without AI, previewed, applied and undone', async ({ page }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await editText(page, {
        element: page.getByRole('heading', { level: 1 }),
        file: 'app/page.tsx',
        path: PAGE,
      });
    });

    test('a linked Jira ticket gets the applied change once Undo is gone', async ({ page }) => {
      test.setTimeout(90_000);
      await jiraLoop(
        page,
        {
          element: page.getByRole('heading', { level: 1 }),
          file: 'app/page.tsx',
          path: PAGE,
        },
        async () => {
          await open(page, next.url);
          await chooseTool(page, 'Select');
        },
      );
    });

    test('a heading rendered from a data array is edited where the array is written', async ({
      page,
    }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await editFoundText(page, {
        element: page.locator('#extras h4'),
        file: 'app/components/Extras.tsx',
        path: EXTRAS,
        caption: 'From TABS · Extras.tsx:2',
      });
    });

    test('the Fill picker applies a theme color and Undo restores it', async ({ page }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await pickThemeColor(page, {
        element: page.getByRole('button', { name: 'Order now' }),
        file: 'app/components/OrderButton.tsx',
        path: ORDER_BUTTON,
      });
    });
    test('dragging a padding handle writes the shorter padding tokens and Undo restores them', async ({
      page,
    }) => {
      await open(page, next.url);
      await chooseTool(page, 'Select');
      await dragPadding(page, {
        element: page.getByRole('button', { name: 'Order now' }),
        file: 'app/components/OrderButton.tsx',
        path: ORDER_BUTTON,
      });
    });
  });
}
