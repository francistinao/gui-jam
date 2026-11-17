import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { cancel, confirm, intro, log, note, outro, select, spinner } from '@clack/prompts';
import { describeProject, detectProject, type Project, runScriptCommand } from './detect.js';
import {
  defaultProvider,
  listModels,
  listProviders,
  type ModelInfo,
  type ProviderInfo,
  providerHint,
  rankModels,
  runAttached,
  useProvider,
} from './gjd.js';
import { PWA_HINT, projectRunsDevServiceWorker } from './pwa.js';
import { spawnTool } from './spawn-tool.js';
import { wireProject } from './wire.js';

export interface InitOptions {
  cwd: string;
  version: string;
  interactive: boolean;
  provider: string | undefined;
  model: string | undefined;
  skipInstall: boolean;
  gjd: string | undefined;
  missingGjd: string;
  highlight: (text: string) => string;
}

const MAPPED_UI = new Set(['React', 'Preact', 'Solid', 'Vue', 'Svelte']);
const OUTPUT_TAIL_LINES = 20;

class Cancelled extends Error {}

class SetupError extends Error {}

function answered<T extends string | boolean>(value: T | symbol): T {
  if (typeof value === 'symbol') throw new Cancelled();
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installArgs(project: Project, spec: string): string[] {
  switch (project.packageManager) {
    case 'npm':
      return ['install', '--save-dev', spec];
    case 'pnpm':
      return [
        'add',
        '--save-dev',
        ...(project.pnpmWorkspaceRoot ? ['--workspace-root'] : []),
        spec,
      ];
    case 'yarn':
    case 'bun':
      return ['add', '--dev', spec];
  }
}

function capture(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTool(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function installStep(project: Project, options: InitOptions): Promise<void> {
  if (project.hasGuijam) {
    log.success('guijam is already a dev dependency');
    return;
  }
  if (options.skipInstall) {
    log.info('Skipped adding guijam to package.json');
    return;
  }
  const spec = `guijam@${options.version}`;
  const args = installArgs(project, spec);
  const progress = spinner();
  progress.start(`Installing ${spec} with ${project.packageManager}`);
  const result = await capture(project.packageManager, args, project.root).catch(
    (error: unknown) => ({
      code: 1,
      output: messageOf(error),
    }),
  );
  if (result.code === 0) {
    progress.stop(`Installed ${spec} as a dev dependency`);
    return;
  }
  progress.error(`${project.packageManager} ${args.join(' ')} failed`);
  log.message(result.output.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n'));
  throw new SetupError('guijam could not be installed.');
}

async function wireStep(project: Project): Promise<boolean> {
  const result = await wireProject(project);
  const shown = (file: string): string => relative(project.root, file) || file;
  switch (result.status) {
    case 'added':
      log.success(`Added GUIJam to ${shown(result.file)}`);
      break;
    case 'present':
      log.success(`${shown(result.file)} already loads GUIJam`);
      break;
    case 'created':
      log.success(`Created ${shown(result.file)} with GUIJam`);
      break;
    case 'manual':
      log.warn(`${result.reason} Add GUIJam yourself:`);
      note(result.snippet, shown(result.file));
      return false;
    case 'unsupported':
      log.warn(result.reason);
      return false;
  }
  if (project.framework !== 'astro' && !MAPPED_UI.has(project.ui ?? '')) {
    log.info(
      `GUIJam maps elements to source in React, Preact, Solid, Vue, Svelte and Astro. ${project.ui ?? 'Plain HTML'} elements won't map to source yet.`,
    );
  }
  return true;
}

async function scan(gjd: string, start: string): Promise<ProviderInfo[]> {
  const progress = spinner();
  progress.start(start);
  try {
    const providers = await listProviders(gjd);
    const installed = providers.filter((provider) => provider.installed).length;
    progress.stop(`Found ${installed} of ${providers.length} supported AI coding CLIs`);
    return providers;
  } catch (error) {
    progress.error('Could not list the AI coding CLIs');
    throw new SetupError(messageOf(error));
  }
}

async function pickProvider(
  providers: ProviderInfo[],
  options: InitOptions,
): Promise<ProviderInfo> {
  if (options.provider !== undefined) {
    const named = providers.find((provider) => provider.id === options.provider);
    if (named === undefined) {
      const ids = providers.map((provider) => provider.id).join(', ');
      throw new SetupError(`Unknown AI tool "${options.provider}". Choose one of: ${ids}.`);
    }
    return named;
  }
  const fallback = defaultProvider(providers);
  if (fallback === undefined) throw new SetupError('gjd reported no AI tools.');
  if (!options.interactive) return fallback;
  const id = answered(
    await select({
      message: 'Which AI coding CLI should GUIJam drive?',
      options: providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        hint: providerHint(provider),
      })),
      initialValue: fallback.id,
    }),
  );
  return providers.find((provider) => provider.id === id) ?? fallback;
}

async function runAndRescan(
  gjd: string,
  provider: ProviderInfo,
  commandLine: string,
  cwd: string,
): Promise<ProviderInfo> {
  try {
    const code = await runAttached(commandLine, cwd);
    if (code !== 0) log.warn(`${commandLine} exited with code ${code}`);
  } catch (error) {
    log.error(`Could not run ${commandLine}: ${messageOf(error)}`);
    return provider;
  }
  const providers = await scan(gjd, `Checking ${provider.name} again`);
  return providers.find((entry) => entry.id === provider.id) ?? provider;
}

async function offer(options: InitOptions, question: string, later: string): Promise<boolean> {
  if (!options.interactive) {
    log.warn(later);
    return false;
  }
  const accepted = answered<boolean>(await confirm({ message: question }));
  if (!accepted) log.info(later);
  return accepted;
}

async function ensureReady(
  gjd: string,
  chosen: ProviderInfo,
  options: InitOptions,
): Promise<ProviderInfo> {
  const { highlight } = options;
  let provider = chosen;
  if (!provider.installed) {
    const command = provider.installCommand;
    const install = await offer(
      options,
      `${provider.name} isn't installed. Install it now with ${highlight(command)}?`,
      `${provider.name} isn't installed yet. Install it with ${highlight(command)}`,
    );
    if (install) provider = await runAndRescan(gjd, provider, command, options.cwd);
  }
  const login = provider.loginCommand;
  if (provider.installed && provider.auth === 'not_logged_in' && login !== undefined) {
    const run = await offer(
      options,
      `${provider.name} isn't logged in. Log in now? This runs ${highlight(login)} in this terminal.`,
      `${provider.name} isn't logged in yet. Log in with ${highlight(login)}`,
    );
    if (run) provider = await runAndRescan(gjd, provider, login, options.cwd);
  }
  return provider;
}

async function loadModels(gjd: string, provider: ProviderInfo): Promise<ModelInfo[]> {
  try {
    return rankModels(await listModels(gjd, provider.id));
  } catch (error) {
    log.warn(`Could not list the ${provider.name} models: ${messageOf(error)}`);
    return [];
  }
}

function modelHint(model: ModelInfo): string | undefined {
  const notes = [model.free ? 'free' : undefined, model.images ? 'reads sketches' : 'text only'];
  return notes.filter((note): note is string => note !== undefined).join(' · ');
}

const ADD_KEY = '\u0000add-key';

async function modelStep(gjd: string, provider: ProviderInfo, options: InitOptions): Promise<void> {
  let models = await loadModels(gjd, provider);
  if (models.length === 0 && options.model === undefined) return;
  const save = async (model: string): Promise<void> => {
    await useProvider(gjd, provider.id, model);
    log.success(`${provider.name} will answer with ${model}`);
  };
  if (options.model !== undefined) {
    if (models.length > 0 && !models.some((model) => model.id === options.model)) {
      throw new SetupError(`${provider.name} has no model "${options.model}".`);
    }
    await save(options.model);
    return;
  }
  if (!options.interactive) {
    const current = provider.model ?? models[0]?.id;
    if (current !== undefined) await save(current);
    return;
  }
  for (;;) {
    const login =
      provider.loginCommand ?? (provider.id === 'opencode' ? 'opencode auth login' : undefined);
    const choice = answered<string>(
      await select({
        message: `Which ${provider.name} model should GUIJam use?`,
        options: [
          ...models.map((model) => {
            const hint = modelHint(model);
            return { value: model.id, label: model.id, ...(hint ? { hint } : {}) };
          }),
          ...(login === undefined
            ? []
            : [{ value: ADD_KEY, label: 'Add a provider key first', hint: `runs ${login}` }]),
        ],
        initialValue: provider.model ?? models[0]?.id ?? ADD_KEY,
      }),
    );
    if (choice !== ADD_KEY) {
      await save(choice);
      return;
    }
    if (login === undefined) return;
    await runAttached(login, options.cwd).catch((error: unknown) => {
      log.error(`Could not run ${login}: ${messageOf(error)}`);
    });
    models = await loadModels(gjd, provider);
  }
}

async function providerStep(options: InitOptions): Promise<boolean> {
  const { gjd } = options;
  if (gjd === undefined) {
    log.warn(options.missingGjd);
    return false;
  }
  const chosen = await pickProvider(await scan(gjd, 'Looking for AI coding CLIs'), options);
  await useProvider(gjd, chosen.id);
  log.success(`GUIJam will drive ${chosen.name}`);
  const provider = await ensureReady(gjd, chosen, options);
  if (provider.installed) await modelStep(gjd, provider, options);
  if (provider.auth === 'logged_in') {
    log.success(`${provider.name} is logged in`);
    return true;
  }
  if (provider.auth === 'unknown' && provider.installed) {
    log.warn(`Could not confirm the ${provider.name} login: ${provider.reason ?? 'no details'}`);
  }
  return false;
}

function insideGitRepo(start: string): boolean {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

async function ignoreStep(root: string): Promise<void> {
  const file = join(root, '.gitignore');
  if (existsSync(file)) {
    const text = await readFile(file, 'utf8');
    if (/^\/?\.guijam\/?\s*$/m.test(text)) return;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    await appendFile(file, `${text === '' || text.endsWith('\n') ? '' : eol}.guijam/${eol}`);
    log.success('Added .guijam/ to .gitignore');
    return;
  }
  if (!insideGitRepo(root)) return;
  await writeFile(file, '.guijam/\n');
  log.success('Created .gitignore with .guijam/');
}

function nextSteps(
  project: Project,
  highlight: (text: string) => string,
  serviceWorker: boolean,
): string {
  const start =
    project.devScript === undefined
      ? 'Start your dev server'
      : `Start your dev server with ${highlight(runScriptCommand(project.packageManager, project.devScript))}`;
  return [
    `1. ${start}`,
    '2. Open your app. The GUIJam toolbar sits at the bottom right.',
    '3. Select an element to fine-tune it, Draw around it for three',
    '   variants, or Ask a question about it.',
    `4. ${highlight('Alt+Shift+M')} hides the toolbar. Something off? Run ${highlight('npx guijam doctor')}`,
    ...(serviceWorker ? ['', PWA_HINT] : []),
  ].join('\n');
}

export async function init(options: InitOptions): Promise<number> {
  intro('Set up GUIJam');
  try {
    const project = detectProject(options.cwd);
    log.success(`Found ${describeProject(project)}`);
    await installStep(project, options);
    const wired = await wireStep(project);
    const ready = await providerStep(options);
    await ignoreStep(project.root);
    note(
      nextSteps(project, options.highlight, await projectRunsDevServiceWorker(project)),
      'Next steps',
    );
    outro(
      wired && ready
        ? "You're set. Happy jamming! - Francis Tin-ao"
        : 'Almost there. Finish the steps flagged above.',
    );
    return 0;
  } catch (error) {
    if (error instanceof Cancelled) {
      cancel('Setup cancelled.');
      return 130;
    }
    cancel(messageOf(error));
    return 1;
  }
}
