import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateError, UpdateResult } from '@guijam/contracts-ts';
import {
  type DevEnvironment,
  type EnvironmentModuleNode,
  normalizePath,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import { injectSourceLocations } from './transform-srcloc.js';
import { createUpdateTracker, isUpdateResult } from './update-tracker.js';

export type { UpdateResult } from '@guijam/contracts-ts';

export interface GuijamApi {
  /**
   * Serves `content` in place of `file` (absolute or relative to the Vite root) without
   * touching the source file. Content that does not compile is rejected with
   * `compile_error` and the previous state is kept.
   */
  setOverlay(file: string, content: string): Promise<UpdateResult>;
  /** Drops the overlay so the module is served from disk again. */
  clearOverlay(file: string): Promise<UpdateResult>;
}

const CLIENT_ID = 'virtual:guijam/client';
const CLIENT_ENTRY = normalizePath(fileURLToPath(new URL('./client.js', import.meta.url)));
const UPDATE_TIMEOUT_MS = 3000;
const JSX_MODULE = /\.[jt]sx$/;
const CSS_ID = /\.css(?:\?.*)?$/;
const NON_STYLESHEET_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;
const TAILWIND_ROOT = /@import\s+["']tailwindcss["']|@tailwind\s+utilities/;

function toUpdateError(error: unknown, file: string): UpdateError {
  const result: UpdateError = {
    message: error instanceof Error ? error.message : String(error),
    file,
    attributed: true,
  };
  if (error instanceof Error) {
    const { loc } = error as Error & { loc?: { line?: unknown } };
    if (typeof loc?.line === 'number') result.line = loc.line;
    if (error.stack) result.stack = error.stack;
  }
  return result;
}

export function guijam(): Plugin<GuijamApi> {
  const overlays = new Map<string, string>();
  const tailwindRootIds = new Set<string>();
  const tracker = createUpdateTracker(UPDATE_TIMEOUT_MS);
  let devServer: ViteDevServer | undefined;
  let root = process.cwd();
  let candidatesDir = '';

  // Tailwind's scanner only reads files on disk, so classes that exist only in an
  // overlay would get no CSS. Overlay text is mirrored into a git-ignored directory
  // that every Tailwind root CSS file lists as an @source (added in transform below).
  async function syncCandidates(id: string, content: string | undefined): Promise<void> {
    const name = relative(root, id).replaceAll(/[\\/]/g, '__');
    const path = join(candidatesDir, name);
    if (content === undefined) await rm(path, { force: true });
    else await writeFile(path, content);
  }

  async function assertCompiles(client: DevEnvironment, modules: readonly EnvironmentModuleNode[]) {
    for (const mod of modules) {
      client.moduleGraph.invalidateModule(mod);
      await client.transformRequest(mod.url);
    }
  }

  function tailwindRootModules(client: DevEnvironment): EnvironmentModuleNode[] {
    return [...tailwindRootIds].flatMap((id) => client.moduleGraph.getModuleById(id) ?? []);
  }

  async function applyOverlay(file: string, content: string | undefined): Promise<UpdateResult> {
    if (!devServer) throw new Error('guijam: the Vite dev server has not started');
    const client = devServer.environments.client;
    const id = normalizePath(resolve(root, file));
    const updateId = randomUUID();
    const startedAt = performance.now();
    const previous = overlays.get(id);

    if (content === undefined) overlays.delete(id);
    else overlays.set(id, content);
    const modules = [...(client.moduleGraph.getModulesByFile(id) ?? [])];

    if (content !== undefined && modules.length > 0) {
      try {
        await assertCompiles(client, modules);
      } catch (error) {
        if (previous === undefined) overlays.delete(id);
        else overlays.set(id, previous);
        for (const mod of modules) client.moduleGraph.invalidateModule(mod);
        return {
          updateId,
          status: 'compile_error',
          latencyMs: performance.now() - startedAt,
          errors: [toUpdateError(error, id)],
        };
      }
    }

    await syncCandidates(id, content);
    // No page has imported the file yet, so there is nothing to update; the
    // overlay is served when the module is first requested.
    if (modules.length === 0) return { updateId, status: 'ok', latencyMs: 0, errors: [] };

    // Stylesheets go first so new utilities exist before the component renders them.
    const reloads = [...(content === undefined ? [] : tailwindRootModules(client)), ...modules];
    const result = tracker.begin(updateId);
    client.hot.send('gj:update-start', {
      updateId,
      urls: reloads.map((mod) => mod.url),
      expectedUpdates: reloads.length,
    });
    for (const mod of reloads) await client.reloadModule(mod);
    return result;
  }

  return {
    name: 'guijam',
    apply: 'serve',
    enforce: 'pre',

    api: {
      setOverlay: (file, content) => applyOverlay(file, content),
      clearOverlay: (file) => applyOverlay(file, undefined),
    },

    config() {
      return { server: { watch: { ignored: ['**/.guijam/**'] } } };
    },

    configResolved(config) {
      root = config.root;
      candidatesDir = join(root, '.guijam', 'run', 'candidates');
    },

    async configureServer(server) {
      devServer = server;
      await mkdir(candidatesDir, { recursive: true });
      server.environments.client.hot.on('gj:update-result', (data) => {
        if (isUpdateResult(data)) tracker.settle(data);
      });
    },

    resolveId(source) {
      return source === CLIENT_ID ? CLIENT_ENTRY : null;
    },

    load(id) {
      return overlays.get(id) ?? null;
    },

    transform: {
      // Must see JSX and Tailwind stylesheets before any other plugin rewrites them.
      order: 'pre',
      handler(code, id) {
        if (JSX_MODULE.test(id)) {
          const projectPath = normalizePath(relative(root, id));
          if (projectPath.startsWith('..') || id.includes('/node_modules/')) return null;
          return injectSourceLocations(code, id, projectPath);
        }
        if (!CSS_ID.test(id) || NON_STYLESHEET_QUERY.test(id) || !TAILWIND_ROOT.test(code)) {
          return null;
        }
        if (this.environment.name === 'client') tailwindRootIds.add(id);
        const cssDir = dirname(id.split('?', 1)[0] ?? id);
        const source = normalizePath(relative(cssDir, candidatesDir));
        return { code: `${code}\n@source "${source}";\n`, map: null };
      },
    },

    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `/@id/${CLIENT_ID}` },
          injectTo: 'head',
        },
      ];
    },
  };
}
