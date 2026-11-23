import type { Locator, Page } from '@playwright/test';

export type Point = readonly [number, number];

export function drawCanvas(page: Page): Locator {
  return page.locator('canvas.guijam-draw');
}

export async function drawStroke(page: Page, points: readonly Point[], steps = 6): Promise<void> {
  const [first, ...rest] = points;
  if (!first) return;
  await page.mouse.move(first[0], first[1]);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(x, y, { steps });
  await page.mouse.up();
}

export function along(points: readonly Point[], perSegment = 4): Point[] {
  const samples: Point[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to) continue;
    for (let step = 0; step < perSegment; step += 1) {
      const share = step / perSegment;
      samples.push([from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share]);
    }
  }
  const last = points.at(-1);
  if (last) samples.push(last);
  return samples;
}

export async function savedStrokes(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const text = sessionStorage.getItem('guijam:jobs');
    if (!text) return [];
    const saved = JSON.parse(text) as {
      jobs: { strokes: unknown[]; sketch: { strokes: unknown[] } | null }[];
    };
    return saved.jobs.map((job) => (job.sketch ? job.sketch.strokes.length : job.strokes.length));
  });
}

export async function covered(page: Page, points: readonly Point[]): Promise<Point[]> {
  return drawCanvas(page).evaluate((canvas, samples) => {
    const root = canvas.getRootNode();
    if (!(root instanceof ShadowRoot)) return [...samples];
    const panels = [...root.querySelectorAll('[role="dialog"], [aria-label^="Drawing "]')].map(
      (element) => element.getBoundingClientRect(),
    );
    const under = (x: number, y: number) =>
      panels.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    return samples.filter(([x, y]) => under(x, y) || root.elementFromPoint(x, y) !== canvas);
  }, points);
}

export async function unpainted(page: Page, points: readonly Point[]): Promise<Point[]> {
  return drawCanvas(page).evaluate((element, samples) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return [...samples];
    const ratio = canvas.width / window.innerWidth;
    return samples.filter(([x, y]) => {
      const left = Math.max(0, Math.round((x - 2) * ratio));
      const top = Math.max(0, Math.round((y - 2) * ratio));
      const { data } = context.getImageData(left, top, Math.ceil(5 * ratio), Math.ceil(5 * ratio));
      for (let at = 3; at < data.length; at += 4) if ((data[at] ?? 0) > 0) return false;
      return true;
    });
  }, points);
}
