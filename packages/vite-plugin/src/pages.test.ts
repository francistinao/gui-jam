import type { GuijamMessage } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import { GRACE_MS, KEEP_FINISHED_MS, Pages, RELOAD_WINDOW_MS } from './pages.js';

function fakeTimers() {
  let now = 0;
  const queue: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        const id = next++;
        queue.push({ at: now + ms, run, id });
        return id;
      },
      clear: (timer: unknown) => {
        const index = queue.findIndex((entry) => entry.id === timer);
        if (index >= 0) queue.splice(index, 1);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const entry of queue.filter((item) => item.at <= now)) {
        queue.splice(queue.indexOf(entry), 1);
        entry.run();
      }
    },
  };
}

const done = (runId: string): GuijamMessage =>
  ({
    type: 'generate.done',
    payload: { runId, summary: 's', elapsedMs: 1, variants: [], dropped: [] },
  }) as unknown as GuijamMessage;

function deferred() {
  let resolve!: (message: GuijamMessage) => void;
  const promise = new Promise<GuijamMessage>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('Pages', () => {
  it('drops the runs of a page that stays away for the grace period', () => {
    const dropped: string[] = [];
    const released: string[] = [];
    const clock = fakeTimers();
    const pages = new Pages<string>(
      (runId) => dropped.push(runId),
      (runId) => released.push(runId),
      clock.timers,
    );
    pages.seen('socket-a', 'page-1');
    pages.started('page-1', 'run-1', new Promise(() => {}));
    pages.started('page-1', 'run-2', new Promise(() => {}));

    pages.left('socket-a');
    expect(released).toEqual(['run-1', 'run-2']);
    clock.advance(GRACE_MS - 1);
    expect(dropped).toEqual([]);
    clock.advance(1);

    expect(dropped).toEqual(['run-1', 'run-2']);
    expect(pages.client('run-1')).toBeUndefined();
  });

  it('keeps the runs when the page comes back on a new socket, and routes them there', () => {
    const dropped: string[] = [];
    const released: string[] = [];
    const clock = fakeTimers();
    const pages = new Pages<string>(
      (runId) => dropped.push(runId),
      (runId) => released.push(runId),
      clock.timers,
    );
    pages.seen('socket-a', 'page-1');
    pages.started('page-1', 'run-1', new Promise(() => {}));
    expect(pages.client('run-1')).toBe('socket-a');

    pages.left('socket-a');
    expect(pages.client('run-1')).toBeUndefined();
    clock.advance(GRACE_MS / 2);
    pages.seen('socket-b', 'page-1');
    clock.advance(GRACE_MS * 2);

    expect(dropped).toEqual([]);
    expect(pages.client('run-1')).toBe('socket-b');
  });

  it('ignores an old socket closing after the page moved to a new one', () => {
    const dropped: string[] = [];
    const released: string[] = [];
    const clock = fakeTimers();
    const pages = new Pages<string>(
      (runId) => dropped.push(runId),
      (runId) => released.push(runId),
      clock.timers,
    );
    pages.seen('socket-a', 'page-1');
    pages.started('page-1', 'run-1', new Promise(() => {}));
    pages.seen('socket-b', 'page-1');

    pages.left('socket-a');
    clock.advance(GRACE_MS);

    expect(dropped).toEqual([]);
    expect(released).toEqual([]);
    expect(pages.client('run-1')).toBe('socket-b');
    pages.left('unknown-socket');
  });

  it('lets a reloaded page attach to a run that is still going or just finished', async () => {
    const clock = fakeTimers();
    const pages = new Pages<string>(
      () => {},
      () => {},
      clock.timers,
    );
    const running = deferred();
    pages.seen('socket-a', 'page-1');
    pages.started('page-1', 'run-1', running.promise);

    const waiting = pages.attach('run-1');
    running.resolve(done('run-1'));
    expect(await waiting).toEqual(done('run-1'));
    await Promise.resolve();
    expect(await pages.attach('run-1')).toEqual(done('run-1'));

    clock.advance(KEEP_FINISHED_MS);
    expect(await pages.attach('run-1')).toBeUndefined();
    expect(await pages.attach('never-started')).toBeUndefined();
  });

  it('forgets a discarded run and its kept reply', async () => {
    const clock = fakeTimers();
    const dropped: string[] = [];
    const released: string[] = [];
    const pages = new Pages<string>(
      (runId) => dropped.push(runId),
      (runId) => released.push(runId),
      clock.timers,
    );
    pages.seen('socket-a', 'page-1');
    pages.started('page-1', 'run-1', Promise.resolve(done('run-1')));
    await Promise.resolve();
    await Promise.resolve();

    pages.discarded('page-1', 'run-1');
    pages.left('socket-a');
    clock.advance(GRACE_MS);

    expect(await pages.attach('run-1')).toBeUndefined();
    expect(dropped).toEqual([]);
  });

  it('keeps the previews of pages that GUIJam itself reloads, then releases again', () => {
    const dropped: string[] = [];
    const released: string[] = [];
    const clock = fakeTimers();
    const pages = new Pages<string>(
      (runId) => dropped.push(runId),
      (runId) => released.push(runId),
      clock.timers,
    );
    pages.seen('socket-a', 'page-1');
    pages.started('page-1', 'run-1', new Promise(() => {}));

    pages.reloading();
    pages.left('socket-a');
    pages.seen('socket-b', 'page-1');
    expect(released).toEqual([]);

    clock.advance(RELOAD_WINDOW_MS);
    pages.left('socket-b');
    expect(released).toEqual(['run-1']);
    expect(dropped).toEqual([]);
  });

  it('still drops the runs of a reloaded page that never comes back', () => {
    const dropped: string[] = [];
    const clock = fakeTimers();
    const pages = new Pages<string>(
      (runId) => dropped.push(runId),
      () => undefined,
      clock.timers,
    );
    pages.seen('socket-a', 'page-1');
    pages.started('page-1', 'run-1', new Promise(() => {}));

    pages.reloading();
    pages.left('socket-a');
    clock.advance(GRACE_MS);

    expect(dropped).toEqual(['run-1']);
  });
});
