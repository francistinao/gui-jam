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
  fixturePath,
  openFixture,
  replaceOnce,
  startFixtureServer,
} from './support/fixture.js';

const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const BUTTON_AT = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const BLUE_FILL = { fill: { kind: 'hex', hex: '#1D4ED8', opacity: 100 } };
const FULL_RADIUS = { radius: { kind: 'token', name: 'full' } };

let fixture: FixtureServer;
let send: ReturnType<typeof widgetRequests>;
let original: string;

function assertReply<T extends GuijamMessage['type']>(
  reply: GuijamMessage | undefined,
  type: T,
): asserts reply is Extract<GuijamMessage, { type: T }> {
  if (reply?.type !== type) throw new Error(`expected ${type}, got ${JSON.stringify(reply)}`);
}

function errorCode(reply: GuijamMessage): string | undefined {
  return reply.type === 'error' ? reply.payload.code : undefined;
}

async function preview(props: object) {
  const reply = await send('finetune.preview', { ...BUTTON_AT, props });
  assertReply(reply, 'finetune.previewed');
  return reply.payload.changesetId;
}

async function commitFill(page: Page) {
  await openFixture(page, fixture.url);
  const reply = await send('changeset.commit', { changesetId: await preview(BLUE_FILL) });
  assertReply(reply, 'commit.done');
  return reply.payload.journalId;
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

test('two undos of the same change sent at once revert it exactly once', async ({ page }) => {
  const journalId = await commitFill(page);

  const replies = await Promise.all([
    send('journal.undo', { journalId }),
    send('journal.undo', { journalId }),
  ]);

  expect(replies.map((reply) => reply.type).sort()).toEqual(['error', 'undo.done']);
  expect(replies.map(errorCode).filter(Boolean)).toEqual(['ALREADY_UNDONE']);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});

test('a double-clicked Apply writes the change once', async ({ page }) => {
  await openFixture(page, fixture.url);
  const changesetId = await preview(BLUE_FILL);

  const replies = await Promise.all([
    send('changeset.commit', { changesetId }),
    send('changeset.commit', { changesetId }),
  ]);

  expect(replies.map((reply) => reply.type).sort()).toEqual(['commit.done', 'error']);
  expect(replies.map(errorCode).filter(Boolean)).toEqual(['UNKNOWN_CHANGESET']);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(
    replaceOnce(original, 'bg-brand', 'bg-[#1D4ED8]'),
  );
  const done = replies.find((reply) => reply.type === 'commit.done');
  assertReply(done, 'commit.done');
  assertReply(await send('journal.undo', { journalId: done.payload.journalId }), 'undo.done');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});

test('undo racing a commit on the same file ends in one serial order', async ({ page }) => {
  const fill = await commitFill(page);
  const radius = await preview(FULL_RADIUS);

  const [undo, commit] = await Promise.all([
    send('journal.undo', { journalId: fill }),
    send('changeset.commit', { changesetId: radius }),
  ]);

  const radiusOnly = replaceOnce(original, 'rounded-lg', 'rounded-full');
  const serialOutcomes = [
    ['undo.done', 'CONFLICT', original],
    ['undo.done', 'commit.done', radiusOnly],
    ['CONFLICT', 'commit.done', replaceOnce(radiusOnly, 'bg-brand', 'bg-[#1D4ED8]')],
  ];
  expect(serialOutcomes).toContainEqual([
    errorCode(undo) ?? undo.type,
    errorCode(commit) ?? commit.type,
    await readFile(ORDER_BUTTON, 'utf8'),
  ]);
});

test('undo of an unknown change writes nothing', async ({ page }) => {
  await openFixture(page, fixture.url);

  const reply = await send('journal.undo', { journalId: 'j0000000000000000000' });

  expect(errorCode(reply)).toBe('UNKNOWN_ENTRY');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});

test('undo after the developer edited the file keeps their edit', async ({ page }) => {
  const journalId = await commitFill(page);
  const developerVersion = replaceOnce(await readFile(ORDER_BUTTON, 'utf8'), 'px-6', 'px-8');
  await writeFile(ORDER_BUTTON, developerVersion);

  const reply = await send('journal.undo', { journalId });

  expect(errorCode(reply)).toBe('CONFLICT');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(developerVersion);
});
