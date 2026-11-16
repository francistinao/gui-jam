import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from './detect.js';
import { addGuijamPlugin, callsGuijam, isWired, wireProject } from './wire.js';

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

  it('leaves frameworks without an adapter untouched', async () => {
    const root = app(
      { 'nuxt.config.ts': 'export default defineNuxtConfig({});\n' },
      { nuxt: '^4.2.0' },
    );

    expect(await wireProject(detectProject(root, {}))).toMatchObject({ status: 'unsupported' });
    expect(readFileSync(join(root, 'nuxt.config.ts'), 'utf8')).toBe(
      'export default defineNuxtConfig({});\n',
    );
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
