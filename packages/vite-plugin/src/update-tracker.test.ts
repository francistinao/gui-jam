import type { UpdateResult } from '@guijam/contracts-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateTracker, isUpdateResult } from './update-tracker.js';

const okResult = (updateId: string): UpdateResult => ({
  updateId,
  status: 'ok',
  latencyMs: 12,
  errors: [],
});

describe('createUpdateTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a pending update with the result the browser reports', async () => {
    const tracker = createUpdateTracker(3000);
    const pending = tracker.begin('u-1');

    tracker.settle(okResult('u-1'));

    await expect(pending).resolves.toEqual(okResult('u-1'));
  });

  it('resolves with timeout when no browser reports before the deadline', async () => {
    const tracker = createUpdateTracker(3000);
    const pending = tracker.begin('u-1');

    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toMatchObject({ updateId: 'u-1', status: 'timeout' });
  });

  it('does not let a result for another update settle the pending one', async () => {
    const tracker = createUpdateTracker(3000);
    const pending = tracker.begin('u-1');

    tracker.settle(okResult('u-2'));
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toMatchObject({ updateId: 'u-1', status: 'timeout' });
  });

  it('ignores a second report for an update that already settled', async () => {
    const tracker = createUpdateTracker(3000);
    const pending = tracker.begin('u-1');

    tracker.settle(okResult('u-1'));
    tracker.settle({ ...okResult('u-1'), status: 'compile_error' });

    await expect(pending).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('isUpdateResult', () => {
  it('accepts a well-formed result', () => {
    expect(isUpdateResult(okResult('u-1'))).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['an unknown status', { ...okResult('u-1'), status: 'done' }],
    ['a missing updateId', { status: 'ok', latencyMs: 1, errors: [] }],
    ['non-numeric latency', { ...okResult('u-1'), latencyMs: '12' }],
    ['errors that are not an array', { ...okResult('u-1'), errors: {} }],
  ])('rejects %s', (_label, value) => {
    expect(isUpdateResult(value)).toBe(false);
  });
});
