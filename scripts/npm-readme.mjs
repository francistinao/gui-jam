import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repo, 'packages/guijam');
const { version } = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const cdn = `https://cdn.jsdelivr.net/npm/guijam@${version}/`;

const shipped = ['LICENSE', 'assets/guijam-readme.jpg'];
const relative = /(\]\(|\b(?:src|href)=")(?!https?:|mailto:|#)([^)"\s]+)/g;

const readme = (await readFile(join(repo, 'README.md'), 'utf8')).replace(
  relative,
  (_match, lead, target) => {
    if (!shipped.includes(target)) {
      throw new Error(`README.md links to ${target}, which the npm package does not ship`);
    }
    return `${lead}${cdn}${target}`;
  },
);

await mkdir(join(packageDir, 'assets'), { recursive: true });
await Promise.all([
  writeFile(join(packageDir, 'README.md'), readme),
  ...shipped.map((file) => copyFile(join(repo, file), join(packageDir, file))),
]);
