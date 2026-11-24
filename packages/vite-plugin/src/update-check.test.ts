import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checksOff, type DistTags, isNewer, newestFor, noticeUpdate } from './update-check.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24);
const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'guijam-update-'));
  roots.push(root);
  return root;
}

function cacheOf(root: string): unknown {
  return JSON.parse(readFileSync(join(root, '.guijam', 'update-check.json'), 'utf8'));
}

async function notice(
  root: string,
  version: string,
  fetchTags: () => Promise<DistTags>,
  now = NOW,
) {
  const lines: string[] = [];
  await noticeUpdate({ root, version, env: {}, now, fetchTags, log: (line) => lines.push(line) });
  return lines;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('isNewer', () => {
  it('orders releases and prereleases the way semver does', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.3.0', '0.3.0-rc.1')).toBe(true);
    expect(isNewer('0.3.0-rc.10', '0.3.0-rc.2')).toBe(true);
    expect(isNewer('0.3.0-rc.1.1', '0.3.0-rc.1')).toBe(true);
    expect(isNewer('0.3.0-rc.1', '0.3.0-beta.5')).toBe(true);
    expect(isNewer('0.3.0-rc.1', '0.3.0')).toBe(false);
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(isNewer('0.2.9', '0.3.0-rc.1')).toBe(false);
    expect(isNewer('not-a-version', '0.3.0')).toBe(false);
  });
});

describe('newestFor', () => {
  it('suggests latest to a stable install and ignores next', () => {
    expect(newestFor('0.2.0', { latest: '0.3.0', next: '0.4.0-rc.1' })).toBe('0.3.0');
  });

  it('suggests the newer of latest and next to a prerelease install', () => {
    expect(newestFor('0.3.0-rc.1', { latest: '0.2.0', next: '0.3.0-rc.2' })).toBe('0.3.0-rc.2');
    expect(newestFor('0.3.0-rc.2', { latest: '0.3.0', next: '0.3.0-rc.2' })).toBe('0.3.0');
  });

  it('suggests nothing when the install is the newest', () => {
    expect(newestFor('0.3.0', { latest: '0.3.0', next: '0.4.0-rc.1' })).toBeUndefined();
    expect(newestFor('0.3.0-rc.1', {})).toBeUndefined();
  });
});

describe('checksOff', () => {
  it('skips local builds, the opt-out variable and CI', () => {
    expect(checksOff('0.0.0', {})).toBe(true);
    expect(checksOff('0.3.0', { GUIJAM_NO_UPDATE_CHECK: '1' })).toBe(true);
    expect(checksOff('0.3.0', { CI: 'true' })).toBe(true);
    expect(checksOff('0.3.0', { CI: '1' })).toBe(true);
    expect(checksOff('0.3.0', { CI: 'false' })).toBe(false);
    expect(checksOff('0.3.0', { CI: '0' })).toBe(false);
    expect(checksOff('0.3.0', { GUIJAM_NO_UPDATE_CHECK: '' })).toBe(false);
    expect(checksOff('0.3.0', {})).toBe(false);
  });
});

describe('noticeUpdate', () => {
  it('asks npm once, caches the answer and prints one line', async () => {
    const root = project();
    const fetchTags = vi.fn(async () => ({ latest: '0.3.1' }));

    expect(await notice(root, '0.3.0', fetchTags)).toEqual([
      '[guijam] guijam 0.3.1 is available (you have 0.3.0). Run npx guijam update to install it.',
    ]);
    expect(fetchTags).toHaveBeenCalledTimes(1);
    expect(cacheOf(root)).toEqual({ checkedAt: NOW, tags: { latest: '0.3.1' } });
  });

  it('uses the cache for a day and keeps printing the line', async () => {
    const root = project();
    await notice(root, '0.3.0', async () => ({ latest: '0.3.1' }));
    const fetchTags = vi.fn(async () => ({ latest: '0.9.9' }));

    const lines = await notice(root, '0.3.0', fetchTags, NOW + DAY - 1);

    expect(fetchTags).not.toHaveBeenCalled();
    expect(lines).toEqual([expect.stringContaining('guijam 0.3.1 is available')]);
  });

  it('asks npm again once the cache is a day old', async () => {
    const root = project();
    await notice(root, '0.3.0', async () => ({ latest: '0.3.1' }));

    const lines = await notice(root, '0.3.0', async () => ({ latest: '0.3.2' }), NOW + DAY);

    expect(lines).toEqual([expect.stringContaining('guijam 0.3.2 is available')]);
    expect(cacheOf(root)).toEqual({ checkedAt: NOW + DAY, tags: { latest: '0.3.2' } });
  });

  it('prints nothing when the install is the newest', async () => {
    expect(await notice(project(), '0.3.1', async () => ({ latest: '0.3.1' }))).toEqual([]);
  });

  it('stays quiet and writes no cache when npm cannot be reached', async () => {
    const root = project();

    const lines = await notice(root, '0.3.0', async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    });

    expect(lines).toEqual([]);
    expect(() => cacheOf(root)).toThrow();
  });

  it('asks npm again when the cache file is corrupt', async () => {
    const root = project();
    await mkdir(join(root, '.guijam'), { recursive: true });
    writeFileSync(join(root, '.guijam', 'update-check.json'), '{"checkedAt":');

    expect(await notice(root, '0.3.0', async () => ({ latest: '0.3.1' }))).toHaveLength(1);
  });

  it('makes no request when the check is off', async () => {
    const fetchTags = vi.fn(async () => ({ latest: '0.3.1' }));
    const lines: string[] = [];

    await noticeUpdate({
      root: project(),
      version: '0.3.0',
      env: { GUIJAM_NO_UPDATE_CHECK: '1' },
      fetchTags,
      log: (line) => lines.push(line),
    });

    expect(fetchTags).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});
