import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const LIST_TIMEOUT_MS = 60_000;

export type AuthState = 'logged_in' | 'not_logged_in' | 'unknown';

export interface ProviderInfo {
  id: string;
  name: string;
  active: boolean;
  installCommand: string;
  installed: boolean;
  auth: AuthState;
  version: string | undefined;
  loginCommand: string | undefined;
  reason: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isAuthState(value: unknown): value is AuthState {
  return value === 'logged_in' || value === 'not_logged_in' || value === 'unknown';
}

function toProvider(entry: unknown): ProviderInfo {
  if (
    !isRecord(entry) ||
    typeof entry.id !== 'string' ||
    typeof entry.name !== 'string' ||
    typeof entry.installCommand !== 'string' ||
    !isAuthState(entry.auth)
  ) {
    throw new Error(`gjd printed an unexpected provider entry: ${JSON.stringify(entry)}`);
  }
  return {
    id: entry.id,
    name: entry.name,
    active: entry.active === true,
    installCommand: entry.installCommand,
    installed: entry.installed === true,
    auth: entry.auth,
    version: optionalString(entry.version),
    loginCommand: optionalString(entry.loginCommand),
    reason: optionalString(entry.reason),
  };
}

export function parseProviderList(stdout: string): ProviderInfo[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('gjd printed something other than a provider list');
  return parsed.map(toProvider);
}

export async function listProviders(gjd: string): Promise<ProviderInfo[]> {
  const { stdout } = await run(gjd, ['provider', 'list', '--json'], { timeout: LIST_TIMEOUT_MS });
  return parseProviderList(stdout);
}

export async function useProvider(gjd: string, id: string): Promise<void> {
  await run(gjd, ['provider', 'use', id]);
}

export async function gjdVersion(gjd: string): Promise<string> {
  const { stdout } = await run(gjd, ['--version']);
  return stdout.trim();
}

export function runCommand(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export function runAttached(commandLine: string, cwd: string): Promise<number> {
  const [command = '', ...args] = commandLine.trim().split(/\s+/);
  return runCommand(command, args, cwd);
}

export function providerHint(provider: ProviderInfo): string {
  if (!provider.installed) return 'not installed';
  const version = provider.version === undefined ? '' : ` · ${provider.version}`;
  if (provider.auth === 'logged_in') return `logged in${version}`;
  if (provider.auth === 'not_logged_in') return `not logged in${version}`;
  return `login status unknown${version}`;
}

export function defaultProvider(providers: ProviderInfo[]): ProviderInfo | undefined {
  return (
    providers.find((provider) => provider.active) ??
    providers.find((provider) => provider.auth === 'logged_in') ??
    providers.find((provider) => provider.installed) ??
    providers[0]
  );
}
