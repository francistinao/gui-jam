import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GuijamApi } from '@guijam/vite-plugin';
import { expect, type Page, test } from '@playwright/test';
import type * as Vite from 'vite';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../fixtures/small-react-tailwind4/', import.meta.url),
);
const ORDER_BUTTON = join(FIXTURE_DIR, 'src/components/OrderButton.tsx');
const COUNTER = join(FIXTURE_DIR, 'src/components/Counter.tsx');
const BRAND_RGB = 'rgb(190, 18, 60)';
const LATENCY_SAMPLES = 50;
const P95_BUDGET_MS = 300;

let vite: typeof Vite;
let server: Vite.ViteDevServer;
let api: GuijamApi;
let baseUrl: string;

// The matrix run swaps the fixture's Vite version, so drive the Vite that the
// fixture itself resolves rather than one hoisted to the repo root.
async function loadFixtureVite(): Promise<typeof Vite> {
  const vitePackageJson = createRequire(join(FIXTURE_DIR, 'package.json')).resolve(
    'vite/package.json',
  );
  return import(pathToFileURL(join(dirname(vitePackageJson), 'dist/node/index.js')).href);
}

function guijamApi(devServer: Vite.ViteDevServer): GuijamApi {
  const plugin = devServer.config.plugins.find(({ name }) => name === 'guijam');
  if (!plugin?.api) throw new Error('guijam is not registered in the fixture vite.config.ts');
  return plugin.api;
}

async function openFixture(page: Page): Promise<void> {
  const connected = page.waitForEvent('console', (msg) => msg.text().includes('[vite] connected'));
  await page.goto(baseUrl);
  await connected;
}

async function fileSnapshot(path: string) {
  const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  return { content, mtimeMs: stats.mtimeMs };
}

function randomChannel(): number {
  return Math.floor(Math.random() * 256);
}

function randomRadiusPx(): number {
  return 100 + Math.floor(Math.random() * 900);
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

function replaceOnce(source: string, find: string, replacement: string): string {
  if (!source.includes(find)) throw new Error(`fixture no longer contains "${find}"`);
  return source.replace(find, replacement);
}

test.beforeAll(async () => {
  vite = await loadFixtureVite();
  server = await vite.createServer({ root: FIXTURE_DIR, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Vite did not report a local URL');
  baseUrl = url;
  api = guijamApi(server);
});

test.afterEach(async () => {
  await api.clearOverlay(ORDER_BUTTON);
  await api.clearOverlay(COUNTER);
});

test.afterAll(async () => {
  await server?.close();
});

test('renders Tailwind classes that exist only in an in-memory overlay, without touching disk', async ({
  page,
}) => {
  const before = await fileSnapshot(ORDER_BUTTON);
  const [r, g, b] = [randomChannel(), randomChannel(), randomChannel()];
  const radius = randomRadiusPx();
  const overlay = replaceOnce(
    before.content,
    'rounded-lg bg-brand',
    `rounded-[${radius}px] bg-[rgb(${r},${g},${b})]`,
  );
  await openFixture(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await expect(button).toHaveCSS('background-color', BRAND_RGB);

  const result = await api.setOverlay(ORDER_BUTTON, overlay);

  expect(result.status).toBe('ok');
  await expect(button).toHaveCSS('background-color', `rgb(${r}, ${g}, ${b})`);
  await expect(button).toHaveCSS('border-top-left-radius', `${radius}px`);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
});

test('keeps React state when an overlay replaces the component module', async ({ page }) => {
  const radius = randomRadiusPx();
  const overlay = replaceOnce(
    await readFile(COUNTER, 'utf8'),
    'rounded-lg',
    `rounded-[${radius}px]`,
  );
  await openFixture(page);
  const counter = page.getByRole('button', { name: /Cups ordered/ });
  await counter.click();
  await counter.click();
  await counter.click();
  await expect(counter).toHaveText('Cups ordered: 3');

  const result = await api.setOverlay(COUNTER, overlay);

  expect(result.status).toBe('ok');
  await expect(counter).toHaveCSS('border-top-left-radius', `${radius}px`);
  await expect(counter).toHaveText('Cups ordered: 3');
});

test('restores the on-disk module when the overlay is cleared', async ({ page }) => {
  const overlay = replaceOnce(await readFile(ORDER_BUTTON, 'utf8'), 'bg-brand', 'bg-espresso');
  await openFixture(page);
  const button = page.getByRole('button', { name: 'Order now' });
  expect((await api.setOverlay(ORDER_BUTTON, overlay)).status).toBe('ok');
  await expect(button).not.toHaveCSS('background-color', BRAND_RGB);

  const result = await api.clearOverlay(ORDER_BUTTON);

  expect(result.status).toBe('ok');
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});

test('reports compile_error, attributed to the file, when overlay content does not compile', async ({
  page,
}) => {
  const broken = replaceOnce(await readFile(ORDER_BUTTON, 'utf8'), 'return (', 'return (<');
  await openFixture(page);

  const result = await api.setOverlay(ORDER_BUTTON, broken);

  expect(result.status).toBe('compile_error');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.attributed).toBe(true);
});

test('lands a new arbitrary-value class on screen within the NFR-PERF-06 budget', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const source = await readFile(ORDER_BUTTON, 'utf8');
  await openFixture(page);
  const button = page.getByRole('button', { name: 'Order now' });
  await expect(button).toBeVisible();

  const visualMs: number[] = [];
  const hmrMs: number[] = [];
  for (let sample = 0; sample < LATENCY_SAMPLES; sample += 1) {
    const [r, g, b] = [randomChannel(), randomChannel(), randomChannel()];
    const expected = `rgb(${r}, ${g}, ${b})`;
    const overlay = replaceOnce(source, 'bg-brand', `bg-[rgb(${r},${g},${b})]`);
    const painted = page.waitForFunction(
      (rgb) => {
        const el = [...document.querySelectorAll('button')].find(
          (candidate) => candidate.textContent === 'Order now',
        );
        return el !== undefined && getComputedStyle(el).backgroundColor === rgb;
      },
      expected,
      { polling: 'raf' },
    );

    const startedAt = performance.now();
    const result = await api.setOverlay(ORDER_BUTTON, overlay);
    await painted;
    visualMs.push(performance.now() - startedAt);

    expect(result.status).toBe('ok');
    hmrMs.push(result.latencyMs);
  }

  const report = {
    vite: vite.version,
    samples: LATENCY_SAMPLES,
    visualP50Ms: Math.round(percentile(visualMs, 50)),
    visualP95Ms: Math.round(percentile(visualMs, 95)),
    clientHmrP50Ms: Math.round(percentile(hmrMs, 50)),
    clientHmrP95Ms: Math.round(percentile(hmrMs, 95)),
  };
  test.info().annotations.push({ type: 's1-latency', description: JSON.stringify(report) });
  console.log(`[s1-latency] ${JSON.stringify(report)}`);
  expect(report.visualP95Ms).toBeLessThanOrEqual(P95_BUDGET_MS);
});
