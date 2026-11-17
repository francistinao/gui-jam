import { intro, log, outro } from '@clack/prompts';
import { supportsNext } from '@guijam/vite-plugin/next/version';
import {
  describeProject,
  detectProject,
  type Project,
  SUPPORTED_FRAMEWORKS,
  VITE_FRAMEWORKS,
} from './detect.js';
import { gjdVersion, listProviders } from './gjd.js';
import { PWA_HINT, projectRunsDevServiceWorker } from './pwa.js';
import { isWired } from './wire.js';

export interface DoctorOptions {
  cwd: string;
  gjd: string | undefined;
  missingGjd: string;
}

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  level: Level;
  message: string;
}

const SUPPORTED_VITE = new Set([6, 7, 8]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

function nodeCheck(): Check {
  const version = process.versions.node;
  return nodeSupported(version)
    ? { level: 'ok', message: `Node ${version}` }
    : { level: 'fail', message: `Node ${version} is too old. GUIJam needs ^20.19.0 or >=22.12.0.` };
}

const CONFIG_NAMES: Partial<Record<Project['framework'], string>> = {
  nuxt: 'nuxt.config',
  astro: 'astro.config',
  next: 'next.config',
};

export async function projectChecks(project: Project): Promise<Check[]> {
  const checks: Check[] = [{ level: 'ok', message: describeProject(project) }];
  if (!SUPPORTED_FRAMEWORKS.has(project.framework)) {
    checks.push({
      level: 'fail',
      message: `GUIJam doesn't plug into ${project.frameworkLabel} yet.`,
    });
    return checks;
  }
  if (project.framework === 'next' && !supportsNext(project.frameworkVersion)) {
    checks.push({
      level: 'fail',
      message: `Next.js ${project.frameworkVersion ?? 'is not installed'}. GUIJam needs Next.js 16.3 or newer.`,
    });
    return checks;
  }
  const major = Number.parseInt(project.viteVersion ?? '', 10);
  if (VITE_FRAMEWORKS.has(project.framework) && !SUPPORTED_VITE.has(major)) {
    checks.push({
      level: 'warn',
      message: `Vite ${project.viteVersion ?? 'is not installed'}. GUIJam supports Vite 6, 7 and 8.`,
    });
  }
  checks.push(
    project.hasGuijam
      ? { level: 'ok', message: 'guijam is a dependency' }
      : { level: 'fail', message: 'guijam is not in package.json. Run npx guijam init.' },
  );
  const config = CONFIG_NAMES[project.framework] ?? 'The Vite config';
  checks.push(
    (await isWired(project))
      ? { level: 'ok', message: `${config} loads guijam` }
      : { level: 'fail', message: `${config} does not load guijam. Run npx guijam init.` },
  );
  if (await projectRunsDevServiceWorker(project)) checks.push({ level: 'warn', message: PWA_HINT });
  return checks;
}

async function toolChecks(options: DoctorOptions): Promise<Check[]> {
  if (options.gjd === undefined) return [{ level: 'fail', message: options.missingGjd }];
  const checks: Check[] = [];
  try {
    checks.push({ level: 'ok', message: `${await gjdVersion(options.gjd)} at ${options.gjd}` });
  } catch (error) {
    return [{ level: 'fail', message: `gjd at ${options.gjd} does not run: ${messageOf(error)}` }];
  }
  const providers = await listProviders(options.gjd);
  const provider =
    providers.find((entry) => entry.active) ??
    providers.find((entry) => entry.auth === 'logged_in');
  if (provider === undefined) {
    const names = providers.map((entry) => entry.name).join(' or ');
    checks.push({
      level: 'fail',
      message: `No AI coding CLI is installed and logged in. Install ${names}.`,
    });
  } else if (!provider.installed) {
    checks.push({
      level: 'fail',
      message: `${provider.name} is chosen but not installed. Install it with ${provider.installCommand}`,
    });
  } else if (provider.auth === 'logged_in') {
    const how = provider.active ? 'chosen' : 'first logged-in CLI';
    const version =
      provider.version === undefined ? provider.name : `${provider.name} ${provider.version}`;
    const name = provider.model === undefined ? version : `${version} with ${provider.model}`;
    checks.push({ level: 'ok', message: `${name} is logged in (${how})` });
  } else if (provider.auth === 'not_logged_in') {
    checks.push({
      level: 'fail',
      message: `${provider.name} is not logged in. Run ${provider.loginCommand ?? 'its login command'}.`,
    });
  } else {
    checks.push({
      level: 'warn',
      message: `${provider.name} login status unknown: ${provider.reason ?? 'no details'}`,
    });
  }
  return checks;
}

export async function doctor(options: DoctorOptions): Promise<number> {
  intro('GUIJam doctor');
  const checks: Check[] = [nodeCheck()];
  try {
    checks.push(...(await projectChecks(detectProject(options.cwd))));
  } catch (error) {
    checks.push({ level: 'fail', message: messageOf(error) });
  }
  try {
    checks.push(...(await toolChecks(options)));
  } catch (error) {
    checks.push({ level: 'fail', message: `Could not check the AI tools: ${messageOf(error)}` });
  }
  for (const check of checks) {
    if (check.level === 'ok') log.success(check.message);
    else if (check.level === 'warn') log.warn(check.message);
    else log.error(check.message);
  }
  const failures = checks.filter((check) => check.level === 'fail').length;
  outro(
    failures === 0
      ? 'Everything looks good.'
      : `${failures} problem${failures === 1 ? '' : 's'} found.`,
  );
  return failures === 0 ? 0 : 1;
}
