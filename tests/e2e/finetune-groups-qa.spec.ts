import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { GuijamMessage } from 'guijam/vite';
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
const APP = fixturePath('src/App.tsx');
const BUTTON_AT = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };

let fixture: FixtureServer;
let send: ReturnType<typeof widgetRequests>;
const originals = new Map<string, string>();

function assertReply<T extends GuijamMessage['type']>(
  reply: GuijamMessage | undefined,
  type: T,
): asserts reply is Extract<GuijamMessage, { type: T }> {
  if (reply?.type !== type) throw new Error(`expected ${type}, got ${JSON.stringify(reply)}`);
}

function paddingTopToken(source: string): string {
  return source.match(/\bpt-\S+?(?=[\s"])/)?.[0] ?? 'none';
}

async function rewrite(file: string, find: string, replacement: string) {
  await writeFile(file, replaceOnce(originals.get(file) ?? '', find, replacement));
  const served = async (path: string) => (await fetch(new URL(path, fixture.url))).text();
  const marker = replacement.match(/className="([^"]*)"/)?.[1] ?? replacement;
  await expect
    .poll(async () => (await served(relative(FIXTURE_DIR, file))).includes(marker))
    .toBe(true);
  const classes = replacement.match(/className="([^"]*)"/)?.[1] ?? replacement;
  for (const name of classes.split(/\s+/).filter((word) => /^[a-z][a-z0-9-]*$/.test(word))) {
    await expect.poll(async () => (await served('src/index.css')).includes(`.${name}`)).toBe(true);
  }
}

function tint(boxShadow: string): string | undefined {
  return boxShadow
    .split(/,(?![^(]*\))/)
    .map((layer) => layer.trim())
    .find((layer) => !layer.startsWith('rgba(0, 0, 0, 0)'))
    ?.replace(/\s-?[\d.]+px.*$/, '');
}

async function selectOrderButton(page: Page) {
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return { button, panel };
}

async function selectAt(page: Page, at: () => Promise<{ x: number; y: number }>) {
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  const { x, y } = await at();
  await page.mouse.click(x, y);
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/App.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  return panel;
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not visible');
  return box;
}

async function applied(page: Page, panel: Locator, file: string): Promise<string> {
  const before = await readFile(file, 'utf8');
  await panel.getByRole('button', { name: 'Apply' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Applied to' });
  await expect(toast).toBeVisible();
  const written = await readFile(file, 'utf8');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFile(file, 'utf8')).toBe(before);
  return written;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  send = widgetRequests(fixture.api);
  for (const file of [ORDER_BUTTON, APP]) originals.set(file, await readFile(file, 'utf8'));
  await waitForDaemon(send, BUTTON_AT);
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

function slowPreviewReplies(page: Page, delayMs: number) {
  const waiting = new Set<string>();
  const seen = { mostInFlight: 0, sent: 0 };
  const parse = (frame: string | Buffer) => {
    try {
      return typeof frame === 'string' ? JSON.parse(frame) : null;
    } catch {
      return null;
    }
  };
  const routed = page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((frame) => {
      const message = parse(frame);
      if (message?.event === 'gj:request' && message.data?.type === 'finetune.preview') {
        waiting.add(message.data.id);
        seen.sent += 1;
        seen.mostInFlight = Math.max(seen.mostInFlight, waiting.size);
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      const message = parse(frame);
      const id = message?.event === 'gj:response' ? message.data?.id : undefined;
      if (!waiting.has(id)) {
        ws.send(frame);
        return;
      }
      setTimeout(() => {
        waiting.delete(id);
        ws.send(frame);
      }, delayMs);
    });
  });
  return { routed, seen, settled: () => waiting.size === 0 };
}

test('sequential previews of one element commit the last one stored', async ({ page }) => {
  await openFixture(page, fixture.url);
  const first = await send('finetune.preview', {
    ...BUTTON_AT,
    props: { layout: { padding: { top: 4 } } },
  });
  assertReply(first, 'finetune.previewed');
  const second = await send('finetune.preview', {
    ...BUTTON_AT,
    props: { layout: { padding: { top: 40 } } },
  });
  assertReply(second, 'finetune.previewed');

  expect(second.payload.changesetId).toBe(first.payload.changesetId);
  const commit = await send('changeset.commit', { changesetId: second.payload.changesetId });
  assertReply(commit, 'commit.done');
  expect(paddingTopToken(await readFile(ORDER_BUTTON, 'utf8'))).toBe('pt-10');
  assertReply(await send('journal.undo', { journalId: commit.payload.journalId }), 'undo.done');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Order now' })).toHaveCSS('padding-top', '12px');
});

test('the widget keeps one preview in flight when replies are slow, and applies the last edit', async ({
  page,
}) => {
  const slow = slowPreviewReplies(page, 500);
  await slow.routed;
  const { panel } = await selectOrderButton(page);
  const size = panel.getByRole('region', { name: 'Text' }).getByLabel('Font size');

  await size.fill('15');
  await page.waitForTimeout(250);
  await size.fill('22');
  await page.waitForTimeout(250);
  await size.fill('18');
  const written = await applied(page, panel, ORDER_BUTTON);

  expect(slow.seen.sent).toBeGreaterThan(0);
  expect(slow.seen.mostInFlight).toBe(1);
  expect(written).toContain('text-lg');
  expect(written).not.toMatch(/text-\[(15|22)px\]/);
});

test('a preview that answers after Revert does not come back, even after a reload', async ({
  page,
}) => {
  const slow = slowPreviewReplies(page, 800);
  await slow.routed;
  const { button, panel } = await selectOrderButton(page);

  await panel.getByRole('region', { name: 'Text' }).getByLabel('Font size').fill('30');
  await expect.poll(() => slow.seen.sent).toBe(1);
  await panel.getByRole('button', { name: 'Revert' }).click();
  await expect.poll(slow.settled).toBe(true);

  await expect(button).toHaveCSS('font-size', '16px');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(originals.get(ORDER_BUTTON));
  await page.reload();
  await expect(button).toHaveCSS('font-size', '16px');
});

for (const [key, presses, px, token] of [
  ['Shift+ArrowDown', 11, 1, 'pb-px'],
  ['Shift+ArrowDown', 10, 2, 'pb-0.5'],
  ['Shift+ArrowDown', 2, 10, 'pb-2.5'],
  ['Shift+ArrowUp', 1, 13, 'pb-[13px]'],
  ['Shift+ArrowUp', 2, 14, 'pb-3.5'],
] as const) {
  test(`the handle label names the class Apply writes: ${token}`, async ({ page }) => {
    const { panel } = await selectOrderButton(page);
    const bottom = page.getByRole('slider', { name: 'Padding bottom' });
    await bottom.focus();
    for (let press = 0; press < presses; press += 1) await page.keyboard.press(key);

    await expect(bottom).toHaveAttribute('aria-valuetext', `${px} · ${token}`);
    expect(await applied(page, panel, ORDER_BUTTON)).toContain(` ${token}`);
  });
}

test('a reversed flex row still offers a gap handle', async ({ page }) => {
  await rewrite(
    APP,
    '<nav className="flex gap-8">',
    '<nav className="flex flex-row-reverse gap-8">',
  );
  const links = page.locator('nav').first().getByRole('link');
  await selectAt(page, async () => {
    const [left, right] = [await boxOf(links.nth(1)), await boxOf(links.nth(0))];
    return { x: (left.x + left.width + right.x) / 2, y: left.y + left.height / 2 };
  });

  await expect(page.locator('nav').first()).toHaveCSS('flex-direction', 'row-reverse');
  await expect(page.getByRole('slider', { name: 'Column gap' })).toHaveAttribute(
    'aria-valuetext',
    '32 · gap-x-8',
  );
});

test('a container with no gap still offers a gap handle that opens it up', async ({ page }) => {
  await rewrite(APP, '<nav className="flex gap-8">', '<nav className="flex gap-0 p-2">');
  const nav = page.locator('nav').first();
  const panel = await selectAt(page, async () => {
    const box = await boxOf(nav);
    return { x: box.x + 3, y: box.y + 3 };
  });
  await expect(nav).toHaveCSS('padding-top', '8px');
  const gap = page.getByRole('slider', { name: 'Column gap' });
  await expect(gap).toHaveAttribute('aria-valuetext', '0 · gap-x-0');
  const size = await gap.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThan(4);

  await gap.focus();
  await page.keyboard.press('ArrowUp');

  await expect(nav).toHaveCSS('column-gap', '4px');
  expect(await applied(page, panel, APP)).toContain('gap-x-1');
});

test('changing the drop shadow keeps the inner shadow', async ({ page }) => {
  await rewrite(
    ORDER_BUTTON,
    'font-medium text-white',
    'font-medium text-white shadow-md inset-shadow-sm',
  );
  const { panel } = await selectOrderButton(page);

  await panel
    .getByRole('region', { name: 'Effects' })
    .getByRole('button', { name: 'Drop shadow lg' })
    .click();

  const written = await applied(page, panel, ORDER_BUTTON);
  expect(written).toContain('shadow-lg');
  expect(written).toContain('inset-shadow-sm');
  expect(written).not.toContain('shadow-md');
});

test('typing several sizes fast and applying at once writes the last one', async ({ page }) => {
  const { panel } = await selectOrderButton(page);
  const size = panel.getByRole('region', { name: 'Text' }).getByLabel('Font size');

  await size.fill('15');
  await size.fill('22');
  await size.fill('18');
  const written = await applied(page, panel, ORDER_BUTTON);

  expect(written).toContain('text-lg');
  expect(written).not.toMatch(/text-\[(15|22)px\]/);
});

test('a drag released outside the window stops following the pointer', async ({ page }) => {
  const { button, panel } = await selectOrderButton(page);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  const box = await bottom.boundingBox();
  if (!box) throw new Error('handle is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 20, { steps: 4 });
  await page.mouse.move(x, -40, { steps: 4 });
  await page.mouse.up();
  const released = await button.evaluate((element) => getComputedStyle(element).paddingBottom);
  await page.mouse.move(x, y);
  await page.mouse.move(x, y - 30, { steps: 6 });
  await page.mouse.move(x, y + 30, { steps: 6 });

  await expect(button).toHaveCSS('padding-bottom', released);
  await panel.getByRole('button', { name: 'Revert' }).click();
  await expect(button).toHaveCSS('padding-bottom', '12px');
});

test('a slow drag then an immediate Apply writes the value the handle shows', async ({ page }) => {
  const { panel } = await selectOrderButton(page);
  const bottom = page.getByRole('slider', { name: 'Padding bottom' });
  const outcomes: string[] = [];
  for (let round = 0; round < 6; round += 1) {
    const box = await bottom.boundingBox();
    if (!box) throw new Error('handle is not visible');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(x, y - step * 4);
      await page.waitForTimeout(125 + (step % 3) * 20);
    }
    await page.mouse.up();
    const shown = (await bottom.getAttribute('aria-valuetext'))?.split(' · ')[1] ?? '';
    const written = await applied(page, panel, ORDER_BUTTON);
    outcomes.push(
      written.includes(` ${shown} `)
        ? 'matches'
        : `shown ${shown}, wrote ${written.match(/\bpb-\S+?(?=[\s"])/)?.[0]}`,
    );
    await page.getByRole('button', { name: 'Order now' }).click();
    await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  }

  expect(outcomes).toEqual(Array.from({ length: 6 }, () => 'matches'));
});

test('adding an inner shadow keeps an arbitrary drop shadow that uses a theme variable', async ({
  page,
}) => {
  const drop = 'shadow-[0_4px_6px_-1px_var(--color-brand)]';
  await rewrite(ORDER_BUTTON, 'font-medium text-white', `font-medium text-white ${drop}`);
  const { panel } = await selectOrderButton(page);

  await panel
    .getByRole('region', { name: 'Effects' })
    .getByRole('button', { name: 'Add inner shadow' })
    .click();
  const written = await applied(page, panel, ORDER_BUTTON);

  expect(written).toContain(drop);
  expect(written).toContain('inset-shadow');
});

test('picking another drop shadow preset keeps the shadow colour', async ({ page }) => {
  await rewrite(
    ORDER_BUTTON,
    'font-medium text-white',
    'font-medium text-white shadow-md shadow-blue-500',
  );
  const { button, panel } = await selectOrderButton(page);
  const shadow = () => button.evaluate((element) => getComputedStyle(element).boxShadow);
  const before = tint(await shadow());
  expect(before).not.toBe('rgba(0, 0, 0, 0.1)');

  await panel
    .getByRole('region', { name: 'Effects' })
    .getByRole('button', { name: 'Drop shadow lg' })
    .click();
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Applied to' })).toBeVisible();

  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('shadow-lg');
  await expect.poll(async () => tint(await shadow())).toBe(before);
});
