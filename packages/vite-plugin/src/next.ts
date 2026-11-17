import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNextRelay } from './next-relay.js';
import { supportsNext } from './next-version.js';

export { supportsNext } from './next-version.js';

type Rules = Record<string, unknown>;

interface WebpackConfig {
  module?: { rules?: unknown[] };
}

export interface NextConfigObject {
  env?: Record<string, string>;
  instrumentationClientInject?: string[];
  turbopack?: { rules?: Rules } & Record<string, unknown>;
  webpack?: (config: WebpackConfig, context: unknown) => WebpackConfig;
  [key: string]: unknown;
}

export type NextConfigInput =
  | NextConfigObject
  | ((phase: string, context: unknown) => NextConfigObject | Promise<NextConfigObject>);

export interface GuijamNextOptions {
  root?: string;
  daemonBinary?: string;
}

const DEV_PHASE = 'phase-development-server';
const CLIENT_MODULE = 'guijam/next/client';
const LOADER = fileURLToPath(new URL('./next-loader.js', import.meta.url));
const GLOBS = ['*.tsx', '*.jsx', '*.css'] as const;
const WEBPACK_TEST = /\.(?:tsx|jsx)$/;
const HELPER_PROCESS = /[\\/]telemetry[\\/]detached-flush\.js$/;

export function runsDevServer(argv: readonly string[]): boolean {
  return !argv.some((arg) => HELPER_PROCESS.test(arg));
}

function versionOf(root: string, name: string): string | undefined {
  try {
    const manifest = createRequire(join(root, 'package.json'))(`${name}/package.json`) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type TurbopackConfig = NonNullable<NextConfigObject['turbopack']>;
type WebpackHook = NonNullable<NextConfigObject['webpack']>;

function withRules(config: NextConfigObject, root: string): TurbopackConfig {
  const rules: Rules = { ...config.turbopack?.rules };
  const loader = { loader: LOADER, options: { root } };
  for (const glob of GLOBS) {
    rules[glob] = [{ condition: { not: 'foreign' }, loaders: [loader] }, ...asList(rules[glob])];
  }
  return { ...config.turbopack, rules };
}

function loaderName(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  const loader =
    typeof entry === 'object' && entry !== null
      ? (entry as { loader?: unknown }).loader
      : undefined;
  return typeof loader === 'string' ? loader : undefined;
}

export function addToStylesheetRules(rules: readonly unknown[], loader: object): number {
  const seen = new Set<unknown[]>();
  let added = 0;
  const visit = (list: readonly unknown[]) => {
    for (const rule of list) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { oneOf, use } = rule as { oneOf?: unknown; use?: unknown };
      if (Array.isArray(oneOf)) visit(oneOf);
      if (!Array.isArray(use) || seen.has(use)) continue;
      seen.add(use);
      if (use.some((entry) => loaderName(entry)?.includes('postcss-loader'))) {
        use.push(loader);
        added += 1;
      }
    }
  };
  visit(rules);
  return added;
}

function withWebpack(config: NextConfigObject, root: string): WebpackHook {
  return (webpackConfig, context) => {
    const next = config.webpack ? config.webpack(webpackConfig, context) : webpackConfig;
    const loader = { loader: LOADER, options: { root } };
    next.module ??= {};
    const rules = next.module.rules ?? [];
    addToStylesheetRules(rules, loader);
    next.module.rules = [
      { test: WEBPACK_TEST, exclude: /node_modules/, enforce: 'pre', use: [loader] },
      ...rules,
    ];
    return next;
  };
}

export function withGuijam(config: NextConfigInput = {}, options: GuijamNextOptions = {}) {
  return async (phase: string, context: unknown): Promise<NextConfigObject> => {
    const resolved = typeof config === 'function' ? await config(phase, context) : config;
    if (phase !== DEV_PHASE || !runsDevServer(process.argv)) return resolved;
    const root = options.root ?? process.cwd();
    const nextVersion = versionOf(root, 'next');
    if (!supportsNext(nextVersion)) {
      console.warn(
        `[guijam] Next.js ${nextVersion ?? '(not found)'} is too old for GUIJam. Upgrade Next.js to 16.3 or newer.`,
      );
      return resolved;
    }
    const relay = await startNextRelay({
      root,
      nextVersion: nextVersion ?? 'unknown',
      pluginVersion: versionOf(root, 'guijam') ?? '0.0.0',
      ...(options.daemonBinary === undefined ? {} : { daemonBinary: options.daemonBinary }),
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[guijam] GUIJam is off for this dev server: ${reason}.`);
      return undefined;
    });
    if (!relay) return resolved;
    return {
      ...resolved,
      env: { ...resolved.env, GUIJAM_RELAY_URL: relay.url, GUIJAM_WIDGET_URL: relay.widgetUrl },
      instrumentationClientInject: [...(resolved.instrumentationClientInject ?? []), CLIENT_MODULE],
      turbopack: withRules(resolved, root),
      webpack: withWebpack(resolved, root),
    };
  };
}
