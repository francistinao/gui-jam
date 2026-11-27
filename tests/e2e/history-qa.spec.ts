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

const RUN_PAGE = `http://qa-${Date.now()}.test/`;

async function commitAt(page: Page, hex: string, pageUrl = RUN_PAGE) {
  await openFixture(page, fixture.url);
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
  return reply.payload.journalId;
}

async function listed(pageUrl = RUN_PAGE) {
  const reply = await send('journal.list', { pageUrl, limit: 100 });
  assertReply(reply, 'journal.entries');
  return reply.payload.entries;
}

test('History lists stay readable while commits land', async ({ page }) => {
  const pageUrl = `${RUN_PAGE}burst`;
  const committed: string[] = [];
  const lists: GuijamMessage[] = [];
  for (let round = 0; round < 8; round += 1) {
    const hex = `#1D4E${String(round).padStart(2, '0')}`;
    const [journalId, ...replies] = await Promise.all([
      commitAt(page, hex, pageUrl),
      send('journal.list', { pageUrl, limit: 100 }),
      send('journal.list', { limit: 100 }),
      send('journal.list', { pageUrl, limit: 100 }),
    ]);
    committed.push(journalId);
    lists.push(...replies);
  }

  expect(lists.map((reply) => errorCode(reply) ?? reply.type)).toEqual(
    Array.from({ length: 24 }, () => 'journal.entries'),
  );
  const ids = (await listed(pageUrl)).map((entry) => entry.id);
  expect(ids).toEqual([...committed].reverse());
});

test('two redos of the same change sent at once redo it once', async ({ page }) => {
  const journalId = await commitAt(page, '#1D4ED8');
  const after = await readFile(ORDER_BUTTON, 'utf8');
  assertReply(await send('journal.undo', { journalId }), 'undo.done');

  const replies = await Promise.all([
    send('journal.redo', { journalId }),
    send('journal.redo', { journalId }),
  ]);

  expect(replies.map((reply) => reply.type).sort()).toEqual(['error', 'redo.done']);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(after);
  expect((await listed()).find((entry) => entry.id === journalId)?.state).toBe('applied');
});

test('undo and redo of one change fired together end in one serial order', async ({ page }) => {
  const journalId = await commitAt(page, '#1D4ED8');
  const after = await readFile(ORDER_BUTTON, 'utf8');

  const [undo, redo] = await Promise.all([
    send('journal.undo', { journalId }),
    send('journal.redo', { journalId }),
  ]);

  const state = (await listed()).find((entry) => entry.id === journalId)?.state;
  expect([
    ['undo.done', 'redo.done', after, 'applied'],
    ['undo.done', 'INVALID_REQUEST', original, 'undone'],
  ]).toContainEqual([
    errorCode(undo) ?? undo.type,
    errorCode(redo) ?? redo.type,
    await readFile(ORDER_BUTTON, 'utf8'),
    state,
  ]);
});

test('redo of a change nobody undid is refused and writes nothing', async ({ page }) => {
  const journalId = await commitAt(page, '#1D4ED8');
  const after = await readFile(ORDER_BUTTON, 'utf8');

  const reply = await send('journal.redo', { journalId });

  expect(errorCode(reply)).toBe('INVALID_REQUEST');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(after);
});

test('a newer change on the same line blocks undo and names it', async ({ page }) => {
  const older = await commitAt(page, '#1D4ED8');
  const newer = await commitAt(page, '#0F766E');
  const before = await readFile(ORDER_BUTTON, 'utf8');
  const title = (await listed()).find((entry) => entry.id === newer)?.title;

  const reply = await send('journal.undo', { journalId: older });

  assertReply(reply, 'error');
  expect(reply.payload.code).toBe('CONFLICT');
  expect(reply.payload.action).toBe(`Undo '${title}' first.`);
  expect(`${reply.payload.message} ${reply.payload.action}`).not.toMatch(/[–—]/);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(before);
});

test('a hand edit on the same line asks to undo it in the editor', async ({ page }) => {
  const journalId = await commitAt(page, '#1D4ED8');
  const developer = replaceOnce(await readFile(ORDER_BUTTON, 'utf8'), 'bg-[#1D4ED8]', 'bg-sky-700');
  await writeFile(ORDER_BUTTON, developer);

  const reply = await send('journal.undo', { journalId });

  assertReply(reply, 'error');
  expect(reply.payload.code).toBe('CONFLICT');
  expect(reply.payload.action).toBe('Undo that edit in your editor, or keep this change.');
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(developer);
});

test('an odd or very long page URL never breaks Apply', async ({ page }) => {
  const scripted = await commitAt(page, '#1D4ED8', 'javascript:alert(1)');
  assertReply(await send('journal.undo', { journalId: scripted }), 'undo.done');
  const long = await commitAt(page, '#0F766E', `${RUN_PAGE}?q=${'x'.repeat(2100)}`);
  assertReply(await send('journal.undo', { journalId: long }), 'undo.done');

  expect(await listed('javascript:alert(1)')).toEqual([]);
  expect(await readFile(ORDER_BUTTON, 'utf8')).toBe(original);
});

test('History keeps its rows and states across a daemon restart', async ({ page }) => {
  const kept = await commitAt(page, '#1D4ED8');
  const undone = await commitAt(page, '#0F766E');
  assertReply(await send('journal.undo', { journalId: undone }), 'undo.done');
  const before = (await listed()).map((entry) => [entry.id, entry.state]);

  await stopDaemon(FIXTURE_DIR);
  await waitForDaemon(send, BUTTON_AT);

  expect((await listed()).map((entry) => [entry.id, entry.state])).toEqual(before);
  expect(before).toEqual(
    expect.arrayContaining([
      [kept, 'applied'],
      [undone, 'undone'],
    ]),
  );
});
