import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORMS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', label: 'macOS on Apple silicon' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', label: 'macOS on Intel' },
  'linux-x64': { os: 'linux', cpu: 'x64', label: 'Linux on x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', label: 'Linux on arm64' },
};

const [requested, binary, version, outDir] = process.argv.slice(2);
if (!requested || !binary || !version || !outDir) {
  console.error('usage: platform-package.mjs <platform|host> <gjd binary> <version> <out dir>');
  process.exit(2);
}
const platform = requested === 'host' ? `${process.platform}-${process.arch}` : requested;
const target = PLATFORMS[platform];
if (!target) {
  console.error(`no gjd package for ${platform}; supported: ${Object.keys(PLATFORMS).join(', ')}`);
  process.exit(2);
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = `@guijam/gjd-${platform}`;
const dir = join(outDir, `gjd-${platform}`);
const manifest = {
  name,
  version,
  description: `The gjd daemon that GUIJam runs, prebuilt for ${target.label}.`,
  license: 'MIT',
  os: [target.os],
  cpu: [target.cpu],
  files: ['bin'],
  preferUnplugged: true,
  ...(process.env.REPO_URL ? { repository: { type: 'git', url: process.env.REPO_URL } } : {}),
};

await mkdir(join(dir, 'bin'), { recursive: true });
await copyFile(binary, join(dir, 'bin/gjd'));
await chmod(join(dir, 'bin/gjd'), 0o755);
await copyFile(join(repo, 'LICENSE'), join(dir, 'LICENSE'));
await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(dir, 'README.md'),
  `# ${name}\n\nThe prebuilt \`gjd\` daemon for [GUIJam](https://www.npmjs.com/package/guijam) on ${target.label}. It is installed with \`guijam\`; you do not need to install it yourself.\n`,
);
console.log(dir);
