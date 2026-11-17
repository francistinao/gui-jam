import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import guijamLoader from './next-loader.js';
import { overlayFileOf } from './next-paths.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'guijam-next-loader-'));
  dirs.push(root);
  mkdirSync(join(root, '.guijam/run/overlays'), { recursive: true });
  mkdirSync(join(root, 'app/components'), { recursive: true });
  return root;
}

function run(root: string, file: string, source: string) {
  const dependencies: string[] = [];
  const context = {
    resourcePath: join(root, file),
    addDependency: (path: string) => dependencies.push(path),
    getOptions: () => ({ root }),
  };
  return { code: guijamLoader.call(context, source), dependencies };
}

const BUTTON = `'use client';\n\nexport function OrderButton() {\n  return <button className="bg-brand">Order</button>;\n}\n`;

describe('guijam next loader', () => {
  it('marks elements with their source location and watches the overlay file', () => {
    const root = project();

    const { code, dependencies } = run(root, 'app/components/OrderButton.tsx', BUTTON);

    expect(code).toContain('data-gj-src="app/components/OrderButton.tsx:4:10"');
    expect(dependencies).toEqual([overlayFileOf(root, 'app/components/OrderButton.tsx')]);
  });

  it('serves a non-empty overlay in place of the file, and the file again once it is cleared', () => {
    const root = project();
    const overlay = overlayFileOf(root, 'app/components/OrderButton.tsx');

    writeFileSync(overlay, BUTTON.replace('bg-brand', 'bg-[#1D4ED8]'));
    expect(run(root, 'app/components/OrderButton.tsx', BUTTON).code).toContain('bg-[#1D4ED8]');

    writeFileSync(overlay, '');
    expect(run(root, 'app/components/OrderButton.tsx', BUTTON).code).toContain('bg-brand');
  });

  it('points Tailwind roots at the candidates folder and leaves other stylesheets alone', () => {
    const root = project();

    expect(run(root, 'app/globals.css', '@import "tailwindcss";\n').code).toBe(
      '@import "tailwindcss";\n\n@source "../.guijam/run/candidates";\n',
    );
    expect(run(root, 'app/plain.css', 'body { margin: 0 }\n').code).toBe('body { margin: 0 }\n');
  });

  it('leaves files outside the project and in node_modules untouched', () => {
    const root = project();
    const outside = {
      resourcePath: join(root, '..', 'elsewhere.tsx'),
      addDependency: () => undefined,
      getOptions: () => ({ root }),
    };

    expect(guijamLoader.call(outside, BUTTON)).toBe(BUTTON);
    expect(run(root, 'node_modules/pkg/index.tsx', BUTTON).code).toBe(BUTTON);
  });
});
