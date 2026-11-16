import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const FIXTURE_DIR = fileURLToPath(new URL('..', import.meta.url));
const outDirs: string[] = [];

async function buildInto(options: { withGuijam: boolean }): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'guijam-build-'));
  outDirs.push(outDir);
  await build({
    root: FIXTURE_DIR,
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
    ...(options.withGuijam
      ? {}
      : { configFile: false as const, plugins: [react(), tailwindcss()] }),
  });
  return outDir;
}

async function filesUnder(dir: string): Promise<Map<string, Buffer>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, Buffer>();
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path), await readFile(path));
  }
  return files;
}

afterAll(async () => {
  await Promise.all(outDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('production build', () => {
  it('is byte-identical with and without guijam() configured', async () => {
    const withGuijam = await filesUnder(await buildInto({ withGuijam: true }));
    const without = await filesUnder(await buildInto({ withGuijam: false }));

    expect([...withGuijam.keys()].sort()).toEqual([...without.keys()].sort());
    for (const [path, bytes] of withGuijam) {
      expect(bytes.equals(without.get(path) ?? Buffer.alloc(0)), path).toBe(true);
    }
  }, 60_000);
});
