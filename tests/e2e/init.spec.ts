import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { GJD_BINARY, requireDaemonBinary, stopDaemon } from './support/daemon.js';
import { FIXTURE_DIR, fixturePath, openFixture, startFixtureServer } from './support/fixture.js';
import { mergeEnv, withSearchPath } from './support/process.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../../packages/guijam/dist/cli.js', import.meta.url));
const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const UNWIRED_CONFIG = `import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
`;

async function copyFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const entry of ['index.html', 'package.json', 'src', 'public']) {
    await cp(fixturePath(entry), join(root, entry), { recursive: true });
  }
  await symlink(join(FIXTURE_DIR, 'node_modules'), join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'vite.config.ts'), UNWIRED_CONFIG);
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await mkdir(join(root, '.git'));
}

async function init(root: string, configHome: string): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    [CLI, 'init', '--yes', '--skip-install', '--provider', 'claude-code', '--cwd', root],
    {
      env: mergeEnv(withSearchPath(process.env, FAKE_CLI_DIR), {
        NO_COLOR: '1',
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        GUIJAM_GJD_BIN: GJD_BINARY,
      }),
    },
  );
  return stdout;
}

test('init wires a fresh app once, saves the AI tool, and the toolbar loads', async ({
  page,
}, testInfo) => {
  await requireDaemonBinary();
  const root = testInfo.outputPath('app');
  const configHome = await mkdtemp(join(tmpdir(), 'guijam-config-'));
  await copyFixture(root);

  const first = await init(root, configHome);

  expect(first).toContain('Added GUIJam to vite.config.ts');
  expect(first).toContain("You're set. Happy jamming! - Francis Tin-ao");
  const config = await readFile(join(root, 'vite.config.ts'), 'utf8');
  expect(config.match(/guijam\(\)/g)).toHaveLength(1);
  expect(config).toContain("import { guijam } from 'guijam/vite';");
  expect(await readFile(join(configHome, 'guijam/config.toml'), 'utf8')).toContain(
    'active = "claude-code"',
  );
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.guijam/\n');

  const second = await init(root, configHome);

  expect(second).toContain('vite.config.ts already loads GUIJam');
  expect(await readFile(join(root, 'vite.config.ts'), 'utf8')).toBe(config);
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.guijam/\n');

  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  const app = await startFixtureServer(undefined, root);
  try {
    await openFixture(page, app.url);
    await expect(page.getByRole('toolbar', { name: 'GUIJam' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Order now' })).toHaveAttribute(
      'data-gj-src',
      'src/components/OrderButton.tsx:3:5',
    );
  } finally {
    await app.server.close();
    await stopDaemon(root);
    delete process.env.GUIJAM_GJD_BIN;
    await rm(configHome, { recursive: true, force: true });
  }
});
