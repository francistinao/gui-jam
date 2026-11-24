import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { update } from './update.js';

const dirs: string[] = [];
const PACKAGE = JSON.stringify({ devDependencies: { vite: '8.0.0', guijam: '0.3.0' } });

function app(manifest: string | null = PACKAGE): string {
  const root = mkdtempSync(join(tmpdir(), 'guijam-update-cli-'));
  dirs.push(root);
  if (manifest !== null) writeFileSync(join(root, 'package.json'), manifest);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('update', () => {
  it('leaves a local build alone without asking npm', async () => {
    const fetchTags = vi.fn(async () => ({ latest: '0.3.1' }));

    expect(await update({ cwd: app(), version: '0.0.0', fetchTags })).toBe(0);
    expect(fetchTags).not.toHaveBeenCalled();
  });

  it('stops when the project does not have guijam', async () => {
    const cwd = app(JSON.stringify({ devDependencies: { vite: '8.0.0' } }));
    const fetchTags = vi.fn(async () => ({ latest: '0.3.1' }));

    expect(await update({ cwd, version: '0.3.0', fetchTags })).toBe(1);
    expect(fetchTags).not.toHaveBeenCalled();
  });

  it('stops outside a project', async () => {
    const fetchTags = vi.fn(async () => ({ latest: '0.3.1' }));

    expect(await update({ cwd: app(null), version: '0.3.0', fetchTags })).toBe(1);
    expect(fetchTags).not.toHaveBeenCalled();
  });

  it('fails when npm cannot be reached', async () => {
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    };

    expect(await update({ cwd: app(), version: '0.3.0', fetchTags: offline })).toBe(1);
  });

  it('installs nothing when the project has the newest guijam', async () => {
    const cwd = app();

    expect(
      await update({ cwd, version: '0.3.1', fetchTags: async () => ({ latest: '0.3.1' }) }),
    ).toBe(0);
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe(PACKAGE);
  });
});
