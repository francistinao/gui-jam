import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeProject, detectProject, runScriptCommand } from './detect.js';

const dirs: string[] = [];

function project(files: Record<string, string>, manifest: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'guijam-detect-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('detectProject', () => {
  it('reads a React + Vite + Tailwind 4 app', () => {
    const root = project(
      { 'pnpm-lock.yaml': '', 'vite.config.ts': 'export default {};' },
      {
        scripts: { dev: 'vite' },
        dependencies: { react: '^19.2.0' },
        devDependencies: { vite: '^8.3.0', tailwindcss: '^4.1.0', typescript: '~5.9.0' },
      },
    );

    const found = detectProject(root, {});

    expect(found).toMatchObject({
      framework: 'vite',
      packageManager: 'pnpm',
      ui: 'React',
      styling: 'Tailwind CSS 4',
      viteVersion: '8.3.0',
      configFile: join(root, 'vite.config.ts'),
      typescript: true,
      devScript: 'dev',
      hasGuijam: false,
    });
    expect(describeProject(found)).toBe('React · Vite 8.3.0 · Tailwind CSS 4 · pnpm');
  });

  it('prefers the packageManager field, then lockfiles, then the user agent', () => {
    const fromField = project({ 'package-lock.json': '{}' }, { packageManager: 'yarn@4.5.0' });
    const fromLock = project({ 'bun.lock': '' }, {});
    const fromAgent = project({}, {});

    expect(detectProject(fromField, {}).packageManager).toBe('yarn');
    expect(detectProject(fromLock, {}).packageManager).toBe('bun');
    expect(
      detectProject(fromAgent, { npm_config_user_agent: 'pnpm/10.20.0 npm/? node/v22' })
        .packageManager,
    ).toBe('pnpm');
  });

  it('tells meta-frameworks apart from plain Vite', () => {
    const nuxt = project({}, { dependencies: { nuxt: '^4.2.0', vue: '^3.5.0' } });
    const kit = project(
      {},
      { devDependencies: { '@sveltejs/kit': '^2.40.0', svelte: '^5.40.0', vite: '^7.1.0' } },
    );
    const laravel = project(
      {},
      { devDependencies: { 'laravel-vite-plugin': '^2.0.0', vite: '^7.1.0' } },
    );
    const router = project(
      { 'vite.config.ts': '' },
      {
        dependencies: { 'react-router': '8.5.1', react: '19.3.1' },
        devDependencies: { '@react-router/dev': '8.5.1', vite: '^8.3.0' },
      },
    );
    const start = project(
      { 'vite.config.ts': '' },
      { dependencies: { '@solidjs/start': '2.2.1', 'solid-js': '1.9.18', vite: '^8.3.0' } },
    );
    const startOnVinxi = project(
      { 'app.config.ts': '' },
      { dependencies: { '@solidjs/start': '1.5.1', 'solid-js': '1.9.18', vinxi: '^0.5.0' } },
    );
    const next = project(
      { 'next.config.ts': '' },
      { dependencies: { next: '16.1.0', react: '19.2.0' } },
    );

    expect(detectProject(nuxt, {})).toMatchObject({ framework: 'nuxt', ui: 'Vue' });
    expect(detectProject(kit, {})).toMatchObject({
      framework: 'sveltekit',
      ui: 'Svelte',
      viteVersion: '7.1.0',
    });
    expect(detectProject(laravel, {}).frameworkLabel).toBe('Laravel + Vite');
    expect(describeProject(detectProject(kit, {}))).toBe(
      'Svelte · SvelteKit on Vite 7.1.0 · CSS · npm',
    );
    expect(detectProject(router, {})).toMatchObject({
      framework: 'react-router',
      frameworkLabel: 'React Router',
      ui: 'React',
      viteVersion: '8.3.0',
      configFile: join(router, 'vite.config.ts'),
    });
    expect(detectProject(start, {})).toMatchObject({
      framework: 'solid-start',
      frameworkLabel: 'SolidStart',
      ui: 'Solid',
      viteVersion: '8.3.0',
    });
    expect(detectProject(startOnVinxi, {})).toMatchObject({
      framework: 'solid-start-vinxi',
      configFile: join(startOnVinxi, 'app.config.ts'),
      viteVersion: undefined,
    });
    expect(detectProject(next, {})).toMatchObject({
      framework: 'next',
      configFile: join(next, 'next.config.ts'),
    });
    expect(describeProject(detectProject(next, {}))).toBe('React · Next.js 16.1.0 · CSS · npm');
  });

  it('reads a package.json that a Windows editor saved with a byte order mark', () => {
    const root = project({ 'vite.config.ts': 'export default {};' }, {});
    writeFileSync(
      join(root, 'package.json'),
      `\uFEFF${JSON.stringify({ devDependencies: { vite: '^8.3.0' } }, null, 2).replaceAll('\n', '\r\n')}`,
    );

    expect(detectProject(root, {})).toMatchObject({ framework: 'vite', viteVersion: '8.3.0' });
  });

  it('explains a missing package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'guijam-detect-'));
    dirs.push(root);

    expect(() => detectProject(root, {})).toThrow(/No package.json/);
  });
});

describe('runScriptCommand', () => {
  it('uses each package manager’s run syntax', () => {
    expect(runScriptCommand('npm', 'dev')).toBe('npm run dev');
    expect(runScriptCommand('bun', 'dev')).toBe('bun run dev');
    expect(runScriptCommand('pnpm', 'dev')).toBe('pnpm dev');
    expect(runScriptCommand('yarn', 'start')).toBe('yarn start');
  });
});
