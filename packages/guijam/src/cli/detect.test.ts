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
    expect(detectProject(next, {})).toMatchObject({
      framework: 'next',
      configFile: join(next, 'next.config.ts'),
    });
    expect(describeProject(detectProject(next, {}))).toBe('React · Next.js · CSS · npm');
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
