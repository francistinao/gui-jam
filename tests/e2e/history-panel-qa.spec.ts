import { readFile, writeFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import type { GuijamMessage } from 'guijam/vite';
import {
  GJD_BINARY,
  requireDaemonBinary,
  stopDaemon,
  waitForDaemon,
  widgetRequests,
} from './support/daemon.js';
import { openSection } from './support/finetune.js';
import {
  FIXTURE_DIR,
  type FixtureServer,
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';

const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const BUTTON_FILE = 'src/components/OrderButton.tsx';
const BUTTON_AT = { file: BUTTON_FILE, line: 3, column: 5 };

let fixture: FixtureServer;
let send: ReturnType<typeof widgetRequests>;
let original: string;
let hexes = Date.now() % 0xeeeeee;

function assertReply<T extends GuijamMessage['type']>(
  reply: GuijamMessage | undefined,
  type: T,
): asserts reply is Extract<GuijamMessage, { type: T }> {
  if (reply?.type !== type) throw new Error(`expected ${type}, got ${JSON.stringify(reply)}`);
}

function uniqueHex(): string {
  hexes = (hexes + 7919) % 0xffffff;
  return `#${hexes.toString(16).padStart(6, '0').toUpperCase()}`;
}

async function commitFill(pageUrl: string) {
  const hex = uniqueHex();
  const previewed = await send('finetune.preview', {
    ...BUTTON_AT,
    props: { fill: { kind: 'hex', hex, opacity: 100 } },
  });
  assertReply(previewed, 'finetune.previewed');
  const reply = await send('changeset.commit', {
    changesetId: previewed.payload.changesetId,
    pageUrl,
  });
  assertReply(reply, 'commit.done');
  return { journalId: reply.payload.journalId, row: `OrderButton · Fill ${hex}, ${BUTTON_FILE}` };
}

function delayReplies(page: Page, type: string, delays: number[]) {
  let count = 0;
  let held = 0;
  const waiting = new Set<string>();
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
      if (message?.event === 'gj:request' && message.data?.type === type)
        waiting.add(message.data.id);
      server.send(frame);
    });
    server.onMessage((frame) => {
      const id = parse(frame)?.data?.id;
      if (!waiting.has(id)) {
        ws.send(frame);
        return;
      }
      waiting.delete(id);
      const delay = delays[count] ?? 0;
      count += 1;
      held += 1;
      setTimeout(() => {
        held -= 1;
        ws.send(frame);
      }, delay);
    });
  });
  return { routed, settled: () => held === 0 && count >= delays.length };
}

async function openHistory(page: Page, url = fixture.url) {
  await openFixture(page, url);
  await page.keyboard.press('Alt+Shift+H');
  const panel = page.getByRole('dialog', { name: 'History' });
  await expect(panel).toBeVisible();
  return panel;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  send = widgetRequests(fixture.api);
  original = await readFile(ORDER_BUTTON, 'utf8');
  await waitForDaemon(send, BUTTON_AT);
});

test.afterEach(async () => {
  if ((await readFile(ORDER_BUTTON, 'utf8')) !== original) await writeFile(ORDER_BUTTON, original);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('switching tabs while a slow list is loading never shows the other tab', async ({ page }) => {
  const elsewhere = await commitFill(`http://qa-elsewhere-${Date.now()}.test/`);
  const slow = delayReplies(page, 'journal.list', [1200, 0]);
  await slow.routed;
  const panel = await openHistory(page);

  await panel.getByRole('tab', { name: 'All pages' }).click();
  await expect.poll(slow.settled, { timeout: 5000 }).toBe(true);

  await expect(panel.getByRole('tab', { name: 'All pages' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panel.getByRole('listitem', { name: elsewhere.row })).toBeVisible();
});

test('a second tab that undoes an already undone change is told and its row catches up', async ({
  page,
  context,
}) => {
  const { row } = await commitFill(fixture.url);
  const other = await context.newPage();
  const first = await openHistory(page);
  const second = await openHistory(other);
  await expect(second.getByRole('listitem', { name: row })).toBeVisible();

  await first.getByRole('listitem', { name: row }).getByRole('button', { name: 'Undo' }).click();
  await expect(
    first.getByRole('listitem', { name: row }).getByRole('button', { name: 'Redo' }),
  ).toBeVisible();
  const undone = await readFile(ORDER_BUTTON, 'utf8');
  await second.getByRole('listitem', { name: row }).getByRole('button', { name: 'Undo' }).click();

  await expect(
    second.getByRole('listitem', { name: row }).getByRole('button', { name: 'Redo' }),
  ).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(undone);
});

test('History works from the keyboard alone', async ({ page }) => {
  const { row } = await commitFill(fixture.url);
  const after = await readFile(ORDER_BUTTON, 'utf8');
  const panel = await openHistory(page);
  const undo = panel.getByRole('listitem', { name: row }).getByRole('button', { name: 'Undo' });

  for (let press = 0; press < 40; press += 1) {
    if (await undo.evaluate((element) => element.matches(':focus'))) break;
    await page.keyboard.press('Tab');
  }
  await expect(undo).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(
    panel.getByRole('listitem', { name: row }).getByRole('button', { name: 'Redo' }),
  ).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(after).not.toBe(original);
});

test('a tweak left open while undoing from History still applies on top', async ({ page }) => {
  const { row } = await commitFill(fixture.url);
  await openFixture(page, fixture.url);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  const button = page.getByRole('button', { name: 'Order now' });
  await button.click();
  const finetune = page.getByRole('dialog', { name: `Fine-tune ${BUTTON_FILE}` });
  await expect(finetune.getByText('Reading the element…')).toHaveCount(0);
  await (await openSection(finetune, 'Opacity')).getByLabel('Element opacity').fill('50');
  await expect(button).toHaveCSS('opacity', '0.5');

  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'History' })
    .click();
  const panel = page.getByRole('dialog', { name: 'History' });
  await panel.getByRole('listitem', { name: row }).getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByText('Change undone.')).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  await expect(button).toHaveCSS('background-color', 'rgb(190, 18, 60)');
  await finetune.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByText(/Applied to/)).toBeVisible();
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('bg-brand');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toContain('opacity-50');
});

test('a page with a very long URL can still Apply and list History', async ({ page }) => {
  const long = `${fixture.url}?state=${'x'.repeat(2100)}`;
  await openFixture(page, long);
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select' })
    .click();
  await page.getByRole('button', { name: 'Order now' }).click();
  const finetune = page.getByRole('dialog', { name: `Fine-tune ${BUTTON_FILE}` });
  await expect(finetune.getByText('Reading the element…')).toHaveCount(0);
  await (await openSection(finetune, 'Opacity')).getByLabel('Element opacity').fill('50');

  await finetune.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByText(/Applied to/)).toBeVisible();
  await page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'History' })
    .click();
  await expect(page.getByRole('dialog', { name: 'History' }).getByRole('alert')).toHaveCount(0);
});
