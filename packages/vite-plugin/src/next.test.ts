import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addToStylesheetRules, runsDevServer, supportsNext, withGuijam } from './next.js';
import { localOrigin, tailwindRootsIn } from './next-relay.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('supportsNext', () => {
  it.each([
    ['16.3.0', true],
    ['16.4.4', true],
    ['17.0.0-canary.1', true],
    ['16.2.9', false],
    ['15.5.0', false],
    [undefined, false],
    ['next', false],
  ])('%s → %s', (version, expected) => {
    expect(supportsNext(version)).toBe(expected);
  });
});

describe('runsDevServer', () => {
  it("skips Next's telemetry flush helper, which also loads next.config", () => {
    expect(runsDevServer(['/node', '/app/node_modules/next/dist/bin/next', 'dev'])).toBe(true);
    expect(
      runsDevServer([
        '/node',
        '/app/node_modules/next/dist/telemetry/detached-flush.js',
        'dev',
        '/app',
      ]),
    ).toBe(false);
  });
});

describe('addToStylesheetRules', () => {
  it("adds the loader after postcss-loader in Next's css rules, once per shared list", () => {
    const shared = [
      { loader: '/next/css-loader' },
      { loader: '/next/postcss-loader/src/index.js' },
    ];
    const rules = [
      { test: /\.m?js$/, use: [{ loader: 'next-swc-loader' }] },
      {
        oneOf: [
          { test: /\.module\.css$/, use: shared },
          { test: /\.css$/, use: shared },
        ],
      },
      { oneOf: [{ test: /\.scss$/, use: ['sass-loader', 'postcss-loader'] }] },
    ];
    const loader = { loader: '/guijam/next-loader.js', options: { root: '/app' } };

    expect(addToStylesheetRules(rules, loader)).toBe(2);

    expect(shared.at(-1)).toBe(loader);
    expect(shared).toHaveLength(3);
    expect(rules[0]?.use).toHaveLength(1);
  });
});

describe('withGuijam', () => {
  it('leaves builds and other phases untouched, including config functions', async () => {
    const config = { reactStrictMode: true };

    expect(await withGuijam(config)('phase-production-build', {})).toBe(config);
    expect(
      await withGuijam(async (phase) => ({ ...config, phase }))('phase-production-server', {}),
    ).toEqual({ reactStrictMode: true, phase: 'phase-production-server' });
  });
});

describe('localOrigin', () => {
  it.each([
    ['http://localhost:3000', true],
    ['http://127.0.0.1:5173', true],
    ['http://[::1]:3000', true],
    ['https://localhost', true],
    ['http://192.168.1.9:3000', false],
    ['https://evil.example', false],
    ['file://localhost/x', false],
    [undefined, false],
    ['not a url', false],
  ])('%s → %s', (origin, expected) => {
    expect(localOrigin(origin)).toBe(expected);
  });
});

describe('tailwindRootsIn', () => {
  it('finds stylesheets that import Tailwind and skips build and dependency folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'guijam-next-scan-'));
    dirs.push(root);
    for (const dir of ['app', 'styles', 'node_modules/pkg', '.next/static']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, 'app/globals.css'), '@import "tailwindcss";\n');
    writeFileSync(join(root, 'styles/plain.css'), 'body { margin: 0 }\n');
    writeFileSync(join(root, 'node_modules/pkg/tw.css'), "@import 'tailwindcss';\n");
    writeFileSync(join(root, '.next/static/tw.css'), '@import "tailwindcss";\n');

    expect(tailwindRootsIn(root)).toEqual([join(root, 'app/globals.css')]);
  });
});
