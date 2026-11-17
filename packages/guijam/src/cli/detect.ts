import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type FrameworkId =
  | 'vite'
  | 'sveltekit'
  | 'react-router'
  | 'solid-start'
  | 'solid-start-vinxi'
  | 'nuxt'
  | 'next'
  | 'astro'
  | 'angular'
  | 'unknown';

export const VITE_FRAMEWORKS: ReadonlySet<FrameworkId> = new Set([
  'vite',
  'sveltekit',
  'react-router',
  'solid-start',
]);

export interface Project {
  root: string;
  packageManager: PackageManager;
  pnpmWorkspaceRoot: boolean;
  framework: FrameworkId;
  frameworkLabel: string;
  ui: string | undefined;
  styling: string;
  viteVersion: string | undefined;
  configFile: string | undefined;
  typescript: boolean;
  devScript: string | undefined;
  hasGuijam: boolean;
}

interface Manifest {
  packageManager?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  scripts?: unknown;
}

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

const CONFIG_EXTENSIONS = ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'];

const UI_LIBRARIES: [string, string][] = [
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['solid-js', 'Solid'],
  ['preact', 'Preact'],
  ['@angular/core', 'Angular'],
  ['lit', 'Lit'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function readManifest(root: string): Manifest {
  const path = join(root, 'package.json');
  if (!existsSync(path)) {
    throw new Error(`No package.json in ${root}. Run this in your app's folder.`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object.`);
  return parsed;
}

function isPackageManager(value: string): value is PackageManager {
  return value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun';
}

function packageManagerOf(
  root: string,
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
): PackageManager {
  if (typeof manifest.packageManager === 'string') {
    const name = manifest.packageManager.split('@')[0] ?? '';
    if (isPackageManager(name)) return name;
  }
  for (let dir = root; ; dir = dirname(dir)) {
    const found = LOCKFILES.find(([file]) => existsSync(join(dir, file)));
    if (found) return found[1];
    if (dirname(dir) === dir) break;
  }
  const agent = env.npm_config_user_agent?.split('/')[0] ?? '';
  return isPackageManager(agent) ? agent : 'npm';
}

function installedManifest(root: string, name: string): unknown {
  for (let dir = root; ; dir = dirname(dir)) {
    const path = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function installedVersion(
  root: string,
  name: string,
  range: string | undefined,
): string | undefined {
  const manifest = installedManifest(root, name);
  if (isRecord(manifest) && typeof manifest.version === 'string') return manifest.version;
  return range?.match(/\d+(\.\d+){0,2}/)?.[0];
}

function majorOf(version: string | undefined): number | undefined {
  const major = Number.parseInt(version ?? '', 10);
  return Number.isNaN(major) ? undefined : major;
}

function findConfig(root: string, base: string, extensions: string[]): string | undefined {
  return extensions.map((ext) => join(root, `${base}.${ext}`)).find((path) => existsSync(path));
}

function frameworkOf(
  root: string,
  deps: Record<string, string>,
): { framework: FrameworkId; label: string; configFile: string | undefined } {
  const viteConfig = findConfig(root, 'vite.config', CONFIG_EXTENSIONS);
  if ('nuxt' in deps) {
    return {
      framework: 'nuxt',
      label: 'Nuxt',
      configFile: findConfig(root, 'nuxt.config', CONFIG_EXTENSIONS),
    };
  }
  if ('next' in deps) {
    return {
      framework: 'next',
      label: 'Next.js',
      configFile: findConfig(root, 'next.config', CONFIG_EXTENSIONS),
    };
  }
  if ('@angular/core' in deps) {
    return {
      framework: 'angular',
      label: 'Angular',
      configFile: findConfig(root, 'angular', ['json']),
    };
  }
  if ('astro' in deps) {
    return {
      framework: 'astro',
      label: 'Astro',
      configFile: findConfig(root, 'astro.config', CONFIG_EXTENSIONS),
    };
  }
  if ('@sveltejs/kit' in deps) {
    return { framework: 'sveltekit', label: 'SvelteKit', configFile: viteConfig };
  }
  if ('@solidjs/start' in deps) {
    return 'vinxi' in deps
      ? {
          framework: 'solid-start-vinxi',
          label: 'SolidStart 1 (vinxi)',
          configFile: findConfig(root, 'app.config', CONFIG_EXTENSIONS),
        }
      : { framework: 'solid-start', label: 'SolidStart', configFile: viteConfig };
  }
  if ('@react-router/dev' in deps) {
    return { framework: 'react-router', label: 'React Router', configFile: viteConfig };
  }
  if ('laravel-vite-plugin' in deps) {
    return { framework: 'vite', label: 'Laravel + Vite', configFile: viteConfig };
  }
  if ('vite' in deps || viteConfig !== undefined) {
    return { framework: 'vite', label: 'Vite', configFile: viteConfig };
  }
  return { framework: 'unknown', label: 'an unknown setup', configFile: undefined };
}

function stylingOf(root: string, deps: Record<string, string>): string {
  const tailwind = installedVersion(root, 'tailwindcss', deps.tailwindcss);
  const major =
    majorOf(tailwind) ??
    ('@tailwindcss/vite' in deps || '@tailwindcss/postcss' in deps ? 4 : undefined);
  return major === undefined ? 'CSS' : `Tailwind CSS ${major}`;
}

function devScriptOf(scripts: Record<string, string>): string | undefined {
  return ['dev', 'start', 'serve'].find((name) => name in scripts);
}

export function detectProject(root: string, env: NodeJS.ProcessEnv = process.env): Project {
  const manifest = readManifest(root);
  const deps = {
    ...stringRecord(manifest.dependencies),
    ...stringRecord(manifest.devDependencies),
  };
  const packageManager = packageManagerOf(root, manifest, env);
  const { framework, label, configFile } = frameworkOf(root, deps);
  return {
    root,
    packageManager,
    pnpmWorkspaceRoot: packageManager === 'pnpm' && existsSync(join(root, 'pnpm-workspace.yaml')),
    framework,
    frameworkLabel: label,
    ui: UI_LIBRARIES.find(([name]) => name in deps)?.[1],
    styling: stylingOf(root, deps),
    viteVersion: VITE_FRAMEWORKS.has(framework)
      ? installedVersion(root, 'vite', deps.vite)
      : undefined,
    configFile,
    typescript: 'typescript' in deps,
    devScript: devScriptOf(stringRecord(manifest.scripts)),
    hasGuijam: 'guijam' in deps,
  };
}

export function runScriptCommand(packageManager: PackageManager, script: string): string {
  if (packageManager === 'npm' || packageManager === 'bun')
    return `${packageManager} run ${script}`;
  return `${packageManager} ${script}`;
}

export function describeProject(project: Project): string {
  const bundler =
    project.viteVersion === undefined
      ? project.frameworkLabel
      : `${project.frameworkLabel} ${project.viteVersion}`;
  const parts = [project.ui, bundler, project.styling, project.packageManager];
  return [...new Set(parts.filter((part): part is string => part !== undefined))].join(' · ');
}
