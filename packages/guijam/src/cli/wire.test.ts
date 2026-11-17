import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from './detect.js';
import {
  addAstroIntegration,
  addGuijamPlugin,
  addNuxtModule,
  callsGuijam,
  hasNuxtModule,
  isWired,
  wireProject,
} from './wire.js';

const REACT_CONFIG = `import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
`;

const dirs: string[] = [];

function app(files: Record<string, string>, devDependencies: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'guijam-wire-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('addGuijamPlugin', () => {
  it('adds guijam() first and keeps the rest of the file', () => {
    const outcome = addGuijamPlugin(REACT_CONFIG);

    expect(outcome.kind).toBe('added');
    if (outcome.kind !== 'added') return;
    expect(outcome.code).toContain("import { guijam } from 'guijam/vite';");
    expect(outcome.code).toContain('plugins: [guijam(), react()],');
    expect(outcome.code).toContain('server: { port: 5173 },');
    expect(outcome.code.endsWith('\n')).toBe(true);
    expect(addGuijamPlugin(outcome.code)).toEqual({ kind: 'present' });
  });

  it('recognises an aliased import as already wired', () => {
    const code =
      "import { guijam as gj } from 'guijam/vite';\nexport default { plugins: [gj()] };\n";

    expect(callsGuijam(code)).toBe(true);
    expect(addGuijamPlugin(code)).toEqual({ kind: 'present' });
  });

  it('follows defineConfig(fn) to the object it returns', () => {
    const code = [
      "import react from '@vitejs/plugin-react';",
      "import { defineConfig } from 'vite';",
      '',
      'export default defineConfig(({ mode }) => {',
      "  const isDev = mode === 'development';",
      '  return {',
      '    plugins: [',
      '      react(),',
      '      ...(isDev ? [] : []),',
      '    ],',
      '  };',
      '});',
      '',
    ].join('\n');

    expect(addGuijamPlugin(code)).toEqual({
      kind: 'added',
      code: code
        .replace("from 'vite';", "from 'vite';\nimport { guijam } from 'guijam/vite';")
        .replace(
          '    plugins: [\n      react(),',
          '    plugins: [\n      guijam(),\n      react(),',
        ),
    });
  });

  it('handles expression-bodied functions, exported variables and missing plugins', () => {
    expect(addGuijamPlugin('export default defineConfig(() => ({ plugins: [] }))\n')).toEqual({
      kind: 'added',
      code: "import { guijam } from 'guijam/vite';\n\nexport default defineConfig(() => ({ plugins: [guijam()] }))\n",
    });
    const variable = `import { defineConfig } from "vite";\nconst config = defineConfig({ base: '/' });\nexport default config;\n`;
    expect(addGuijamPlugin(variable)).toEqual({
      kind: 'added',
      code: variable
        .replace('from "vite";', 'from "vite";\nimport { guijam } from "guijam/vite";')
        .replace("{ base: '/' }", "{ plugins: [guijam()], base: '/' }"),
    });
  });

  it('falls back to manual steps when it cannot tell where plugins go', () => {
    const branching =
      'export default defineConfig(({ mode }) => {\n  if (mode) return { plugins: [] };\n  return { plugins: [] };\n});\n';
    const computed = 'export default defineConfig({ plugins: getPlugins() });\n';

    expect(addGuijamPlugin(branching)).toMatchObject({ kind: 'manual' });
    expect(addGuijamPlugin(computed)).toMatchObject({ kind: 'manual' });
  });

  it('falls back to manual steps when the file does not parse', () => {
    expect(addGuijamPlugin('export default {')).toMatchObject({ kind: 'manual' });
  });
});

describe('wireProject', () => {
  it('edits vite.config.ts once', async () => {
    const root = app({ 'vite.config.ts': REACT_CONFIG }, { vite: '^8.3.0', react: '^19.2.0' });
    const project = detectProject(root, {});

    expect(await wireProject(project)).toEqual({
      status: 'added',
      file: join(root, 'vite.config.ts'),
    });
    expect(await wireProject(project)).toEqual({
      status: 'present',
      file: join(root, 'vite.config.ts'),
    });
    expect(await isWired(project)).toBe(true);
  });

  it('creates a Vite config when the app has none', async () => {
    const root = app({}, { vite: '^8.3.0', typescript: '~5.9.0' });

    expect(await wireProject(detectProject(root, {}))).toEqual({
      status: 'created',
      file: join(root, 'vite.config.ts'),
    });
    expect(callsGuijam(readFileSync(join(root, 'vite.config.ts'), 'utf8'))).toBe(true);
  });

  it('adds guijam() ahead of the React Router plugin', async () => {
    const config = `import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [reactRouter()],
});
`;
    const root = app(
      { 'vite.config.ts': config },
      { '@react-router/dev': '8.5.1', vite: '^8.3.0' },
    );

    expect(await wireProject(detectProject(root, {}))).toEqual({
      status: 'added',
      file: join(root, 'vite.config.ts'),
    });
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain(
      'plugins: [guijam(), reactRouter()]',
    );
  });

  it('never writes a bare Vite config for a meta-framework that has none', async () => {
    for (const devDependencies of [
      { '@react-router/dev': '8.5.1', vite: '^8.3.0' },
      { '@sveltejs/kit': '^3.1.0', vite: '^8.3.0' },
    ]) {
      const root = app({}, devDependencies);

      expect(await wireProject(detectProject(root, {}))).toMatchObject({
        status: 'manual',
        file: join(root, 'vite.config.mjs'),
        reason: expect.stringMatching(/needs its own plugin in vite\.config\.mjs/),
      });
      expect(existsSync(join(root, 'vite.config.mjs'))).toBe(false);
    }
  });

  it('explains that SolidStart 1 runs on vinxi rather than Vite', async () => {
    const root = app(
      { 'app.config.ts': 'export default {};\n' },
      { '@solidjs/start': '1.5.1', vinxi: '^0.5.0' },
    );

    expect(await wireProject(detectProject(root, {}))).toEqual({
      status: 'unsupported',
      reason:
        "GUIJam doesn't plug into SolidStart 1 (vinxi) yet. SolidStart 1 runs on vinxi; upgrade to SolidStart 2, which runs on Vite.",
    });
  });

  it('adds the Astro integration first and recognises it under any local name', async () => {
    const config = `import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [react()],
});
`;
    const root = app({ 'astro.config.mjs': config }, { astro: '7.4.5' });
    const project = detectProject(root, {});

    expect(await wireProject(project)).toEqual({
      status: 'added',
      file: join(root, 'astro.config.mjs'),
    });
    const written = readFileSync(join(root, 'astro.config.mjs'), 'utf8');
    expect(written).toContain("import guijam from 'guijam/astro';");
    expect(written).toContain('integrations: [guijam(), react()]');
    expect(await isWired(project)).toBe(true);
    expect(await wireProject(project)).toEqual({
      status: 'present',
      file: join(root, 'astro.config.mjs'),
    });
    expect(
      addAstroIntegration(
        "import gj from 'guijam/astro';\nexport default { integrations: [gj()] };\n",
      ),
    ).toEqual({ kind: 'present' });
  });

  it('creates an Astro config with the integration when the app has none', async () => {
    const root = app({}, { astro: '7.4.5' });

    expect(await wireProject(detectProject(root, {}))).toEqual({
      status: 'created',
      file: join(root, 'astro.config.mjs'),
    });
    expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toContain(
      'integrations: [guijam()]',
    );
  });

  it('falls back to the Astro snippet when integrations are computed', async () => {
    const root = app(
      { 'astro.config.mjs': 'export default { integrations: list() };\n' },
      { astro: '7.4.5' },
    );

    expect(await wireProject(detectProject(root, {}))).toMatchObject({
      status: 'manual',
      reason: "astro.config.mjs can't be edited safely: its integrations are not a plain array.",
      snippet: expect.stringContaining("import guijam from 'guijam/astro';"),
    });
  });

  it('leaves frameworks without an adapter untouched', async () => {
    const root = app({ 'next.config.mjs': 'export default {};\n' }, { next: '^16.0.0' });

    expect(await wireProject(detectProject(root, {}))).toMatchObject({ status: 'unsupported' });
    expect(readFileSync(join(root, 'next.config.mjs'), 'utf8')).toBe('export default {};\n');
  });

  it('adds the Nuxt module once and recognises it afterwards', async () => {
    const root = app(
      {
        'nuxt.config.ts':
          'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n',
      },
      { nuxt: '4.6.4' },
    );
    const project = detectProject(root, {});

    expect(await wireProject(project)).toMatchObject({ status: 'added' });
    expect(readFileSync(join(root, 'nuxt.config.ts'), 'utf8')).toBe(
      "export default defineNuxtConfig({\n  modules: ['guijam/nuxt'],\n  devtools: { enabled: true },\n});\n",
    );
    expect(await isWired(project)).toBe(true);
    expect(await wireProject(project)).toMatchObject({ status: 'present' });
  });

  it('returns the snippet when it cannot edit safely', async () => {
    const code =
      "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: getPlugins() });\n";
    const root = app({ 'vite.config.js': code }, { vite: '^8.3.0' });

    const result = await wireProject(detectProject(root, {}));

    expect(result).toMatchObject({ status: 'manual', file: join(root, 'vite.config.js') });
    expect(readFileSync(join(root, 'vite.config.js'), 'utf8')).toBe(code);
  });
});

describe('addNuxtModule', () => {
  it.each([
    [
      "export default defineNuxtConfig({ modules: ['@nuxt/ui'] });\n",
      "export default defineNuxtConfig({ modules: ['guijam/nuxt', '@nuxt/ui'] });\n",
    ],
    [
      'export default defineNuxtConfig({ modules: [] });\n',
      "export default defineNuxtConfig({ modules: ['guijam/nuxt'] });\n",
    ],
    [
      'export default defineNuxtConfig({});\n',
      "export default defineNuxtConfig({ modules: ['guijam/nuxt'] });\n",
    ],
    [
      'export default defineNuxtConfig({ modules: ["@pinia/nuxt"] });\n',
      'export default defineNuxtConfig({ modules: ["guijam/nuxt", "@pinia/nuxt"] });\n',
    ],
    [
      "const config = defineNuxtConfig({\n  modules: [\n    '@pinia/nuxt',\n  ],\n});\nexport default config;\n",
      "const config = defineNuxtConfig({\n  modules: [\n    'guijam/nuxt',\n    '@pinia/nuxt',\n  ],\n});\nexport default config;\n",
    ],
  ])('adds guijam/nuxt to %j', (code, expected) => {
    expect(addNuxtModule(code)).toEqual({ kind: 'added', code: expected });
    expect(hasNuxtModule(expected)).toBe(true);
  });

  it('knows when the module is already there, as a string or with options', () => {
    expect(
      addNuxtModule("export default defineNuxtConfig({ modules: ['guijam/nuxt'] });\n"),
    ).toEqual({ kind: 'present' });
    expect(
      addNuxtModule("export default defineNuxtConfig({ modules: [['guijam/nuxt', {}]] });\n"),
    ).toEqual({ kind: 'present' });
  });

  it('falls back to manual steps when modules are computed or the file does not parse', () => {
    expect(
      addNuxtModule('export default defineNuxtConfig({ modules: getModules() });\n'),
    ).toMatchObject({
      kind: 'manual',
      reason: 'its modules are not a plain array',
    });
    expect(addNuxtModule('export default defineNuxtConfig({').kind).toBe('manual');
    expect(hasNuxtModule('export default defineNuxtConfig({ modules: getModules() });\n')).toBe(
      false,
    );
  });
});
