import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findDaemonBinary, platformKey } from '@guijam/vite-plugin/daemon-binary';
import { colorDepth, highlighter, renderBanner } from './banner.js';
import { doctor } from './doctor.js';
import { runCommand } from './gjd.js';
import { init } from './init.js';

const HELP = `Usage: guijam <command> [options]

Commands
  init                 Set up GUIJam in this project
  doctor               Check the setup
  provider list        List the AI coding CLIs GUIJam can drive
  provider use <id>    Choose the CLI GUIJam drives

Options
  -y, --yes            Use the defaults instead of asking
      --provider <id>  The AI tool to use: claude-code, codex or opencode
      --model <id>     The model to use with it, such as deepseek/deepseek-chat
      --skip-install   Don't add guijam to package.json
      --cwd <dir>      Run in another folder
  -h, --help           Show this help
  -v, --version        Show the version
`;

function packageVersion(): string {
  const manifest: unknown = createRequire(import.meta.url)('guijam/package.json');
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
    return String(manifest.version);
  }
  return '0.0.0';
}

function missingGjd(): string {
  return `No gjd binary for ${platformKey()}. GUIJam ships gjd for macOS and Linux (arm64, x64). Reinstall guijam, or set GUIJAM_GJD_BIN to a gjd binary.`;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean', short: 'y' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'skip-install': { type: 'boolean' },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === 'provider') {
    const gjd = findDaemonBinary();
    if (gjd === undefined) {
      process.stderr.write(`${missingGjd()}\n`);
      return 1;
    }
    return runCommand(gjd, ['provider', ...(rest.length === 0 ? ['list'] : rest)], process.cwd());
  }

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const version = packageVersion();
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const depth = colorDepth(process.env, process.stdout.isTTY === true);
  const banner = (): void => {
    process.stdout.write(
      `\n${renderBanner({ version, depth, columns: process.stdout.columns ?? 80 })}\n\n`,
    );
  };
  const cwd = resolve(values.cwd ?? process.cwd());
  const command = values.help ? 'help' : positionals[0];

  switch (command) {
    case 'init':
      banner();
      return init({
        cwd,
        version,
        interactive:
          values.yes !== true && process.stdin.isTTY === true && process.stdout.isTTY === true,
        provider: values.provider,
        model: values.model,
        skipInstall: values['skip-install'] === true,
        gjd: findDaemonBinary(),
        missingGjd: missingGjd(),
        highlight: highlighter(depth),
      });
    case 'doctor':
      return doctor({ cwd, gjd: findDaemonBinary(), missingGjd: missingGjd() });
    case undefined:
    case 'help':
      banner();
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}
