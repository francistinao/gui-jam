import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf('--project');
const project = at >= 0 ? process.argv[at + 1] : undefined;
if (!project || !/^[A-Z][A-Z0-9_]*$/.test(project)) {
  console.error('Usage: pnpm seed:jira --project KEY   (KEY is your Jira project key, like WEB)');
  process.exit(2);
}

const tickets = [
  ['1-subscribe', 'Make the Subscribe button blue and pill-shaped'],
  ['2-heading', 'Rename the hero heading'],
  ['3-plan', 'Rename the Barista plan to Barista Club'],
  ['4-badge', 'Add a "Most popular" badge to the Barista plan'],
];

for (const [name, summary] of tickets) {
  const image = join(here, `${name}.png`);
  try {
    execFileSync(
      'npx',
      [
        'guijam',
        'jira',
        'create',
        '--project',
        project,
        '--summary',
        summary,
        '--description-file',
        join(here, `${name}.md`),
        ...(existsSync(image) ? ['--image', image] : []),
      ],
      { stdio: 'inherit' },
    );
  } catch {
    process.exit(1);
  }
}
