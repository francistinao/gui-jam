import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from './detect.js';
import { nodeSupported, projectChecks, updateCheck } from './doctor.js';

const dirs: string[] = [];

function app(files: Record<string, string>, devDependencies: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'guijam-doctor-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('nodeSupported', () => {
  it('matches ^20.19.0 || >=22.12.0', () => {
    expect(nodeSupported('v20.19.0')).toBe(true);
    expect(nodeSupported('20.18.3')).toBe(false);
    expect(nodeSupported('21.7.3')).toBe(false);
    expect(nodeSupported('22.11.0')).toBe(false);
    expect(nodeSupported('22.12.0')).toBe(true);
    expect(nodeSupported('24.3.0')).toBe(true);
  });
});

describe('projectChecks', () => {
  it('accepts wired Nuxt and Astro apps without asking for a Vite version', async () => {
    const nuxt = app(
      { 'nuxt.config.ts': "export default defineNuxtConfig({ modules: ['guijam/nuxt'] });\n" },
      { nuxt: '^4.2.0', guijam: '0.1.0' },
    );
    const astro = app(
      {
        'astro.config.mjs':
          "import guijam from 'guijam/astro';\nexport default { integrations: [guijam()] };\n",
      },
      { astro: '7.4.5', guijam: '0.1.0' },
    );

    const nuxtChecks = await projectChecks(detectProject(nuxt, {}));
    const astroChecks = await projectChecks(detectProject(astro, {}));

    expect(nuxtChecks.filter((check) => check.level !== 'ok')).toEqual([]);
    expect(nuxtChecks.map((check) => check.message)).toContain('nuxt.config loads guijam');
    expect(astroChecks.filter((check) => check.level !== 'ok')).toEqual([]);
    expect(astroChecks.map((check) => check.message)).toContain('astro.config loads guijam');
  });

  it('says how to wire an Astro app that does not load guijam yet', async () => {
    const astro = app(
      { 'astro.config.mjs': 'export default { integrations: [] };\n' },
      { astro: '7.4.5', guijam: '0.1.0' },
    );

    expect(await projectChecks(detectProject(astro, {}))).toContainEqual({
      level: 'fail',
      message: 'astro.config does not load guijam. Run npx guijam init.',
    });
  });
});

describe('updateCheck', () => {
  it('names the newer guijam and the command to install it', async () => {
    expect(await updateCheck('0.3.0', {}, async () => ({ latest: '0.3.1' }))).toEqual({
      level: 'warn',
      message: 'guijam 0.3.1 is available (you have 0.3.0). Run npx guijam update to install it.',
    });
  });

  it('says the install is the newest', async () => {
    expect(await updateCheck('0.3.1', {}, async () => ({ latest: '0.3.1' }))).toEqual({
      level: 'ok',
      message: 'guijam 0.3.1 is the newest version',
    });
  });

  it('warns without failing when npm cannot be reached', async () => {
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    };

    expect(await updateCheck('0.3.0', {}, offline)).toEqual({
      level: 'warn',
      message: "Couldn't check npm for a newer guijam",
    });
  });

  it('adds no line when the check is off', async () => {
    const fetchTags = async () => ({ latest: '0.3.1' });

    expect(await updateCheck('0.3.0', { GUIJAM_NO_UPDATE_CHECK: '1' }, fetchTags)).toBeUndefined();
    expect(await updateCheck('0.0.0', {}, fetchTags)).toBeUndefined();
  });
});
