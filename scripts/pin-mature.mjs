import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const STABLE = /^\d+\.\d+\.\d+$/;
const SECTIONS = ['dependencies', 'devDependencies'];

const [file, ...skipped] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/pin-mature.mjs <package.json> [package to leave alone...]');
  process.exit(2);
}

const compare = (a, b) => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

const majorOf = (spec) => {
  const found = /(\d+)(?:\.\d+){0,2}/.exec(spec);
  return found ? Number(found[1]) : undefined;
};

const matureVersion = (name, spec) => {
  const times = JSON.parse(
    execFileSync('npm', ['view', name, 'time', '--json'], { encoding: 'utf8' }),
  );
  const cutoff = Date.now() - MIN_AGE_MS;
  const mature = Object.entries(times)
    .filter(([version, date]) => STABLE.test(version) && Date.parse(date) <= cutoff)
    .map(([version]) => version)
    .sort(compare);
  const major = majorOf(spec);
  const sameMajor = mature.filter((version) => Number(version.split('.')[0]) === major);
  return (sameMajor.length > 0 ? sameMajor : mature).at(-1);
};

const manifest = JSON.parse(readFileSync(file, 'utf8'));
for (const section of SECTIONS) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    if (skipped.includes(name) || /^(?:file|link|workspace|git|https?):/.test(spec)) continue;
    const version = matureVersion(name, spec);
    if (version && version !== spec) {
      console.log(`${name}: ${spec} -> ${version}`);
      manifest[section][name] = version;
    }
  }
}
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
