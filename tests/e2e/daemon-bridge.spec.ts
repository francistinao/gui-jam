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
const BUTTON_AT = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const BRAND_RGB = 'rgb(190, 18, 60)';
const BLUE_RGB = 'rgb(29, 78, 216)';
const BLUE_FILL = { fill: { kind: 'hex', hex: '#1D4ED8', opacity: 100 } };

let fixture: FixtureServer;
let send: ReturnType<typeof widgetRequests>;
let original: string;

function assertReply<T extends GuijamMessage['type']>(
  reply: GuijamMessage,
  type: T,
): asserts reply is Extract<GuijamMessage, { type: T }> {
  if (reply.type !== type) throw new Error(`expected ${type}, got ${JSON.stringify(reply)}`);
}

function changedLines(before: string, after: string): string[] {
  const afterLines = after.split('\n');
  return before
    .split('\n')
    .flatMap((line, index) =>
      line === afterLines[index] ? [] : [`${line} → ${afterLines[index]}`],
    );
}

async function openPage(page: Page) {
  await openFixture(page, fixture.url);
  const button = page.getByRole('button', { name: 'Order now' });
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  return button;
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

test('labels an element’s classes with the project’s theme tokens', async ({ page }) => {
  await openPage(page);

  const reply = await send('element.inspect', BUTTON_AT);
  assertReply(reply, 'element.style');
  const style = reply.payload;

  expect(style.classSource).toBe('static');
  expect(style.tokens).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        token: 'bg-brand',
        group: 'fill',
        themeToken: 'brand',
        value: '#BE123C',
      }),
      expect.objectContaining({
        token: 'rounded-lg',
        group: 'radius',
        themeToken: 'lg',
        value: '8px',
      }),
    ]),
  );
});

test('previews a fill live, commits one line, and undo restores the exact bytes', async ({
  page,
}) => {
  const button = await openPage(page);
  const before = await fileSnapshot(ORDER_BUTTON);

  const preview = await send('finetune.preview', { ...BUTTON_AT, props: BLUE_FILL });
  assertReply(preview, 'finetune.previewed');
  const previewed = preview.payload;

  expect(previewed.update.status).toBe('ok');
  expect(previewed.changes).toHaveLength(1);
  expect(previewed.changes[0]?.after.join('\n')).toContain('bg-[#1D4ED8]');
  await expect(button).toHaveCSS('background-color', BLUE_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);

  const commit = await send('changeset.commit', { changesetId: previewed.changesetId });
  assertReply(commit, 'commit.done');
  const committed = commit.payload;

  const written = await readFile(ORDER_BUTTON, 'utf8');
  expect(committed.summary).toBe('src/components/OrderButton.tsx:3 · bg-brand → bg-[#1D4ED8]');
  expect(changedLines(original, written)).toHaveLength(1);
  await expect(button).toHaveCSS('background-color', BLUE_RGB);

  assertReply(await send('journal.undo', { journalId: committed.journalId }), 'undo.done');

  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});

test('refuses to overwrite a developer edit made after the preview', async ({ page }) => {
  const button = await openPage(page);
  const preview = await send('finetune.preview', { ...BUTTON_AT, props: BLUE_FILL });
  assertReply(preview, 'finetune.previewed');
  const previewed = preview.payload;
  const developerVersion = replaceOnce(original, 'px-6', 'px-8');
  await writeFile(ORDER_BUTTON, developerVersion);

  const reply = await send('changeset.commit', { changesetId: previewed.changesetId });

  assertReply(reply, 'error');
  expect(reply.payload.code).toBe('CONFLICT');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(developerVersion);
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
});
