import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GuijamMessage, UpdateError, UpdateResult } from '@guijam/contracts-ts';
import MagicString from 'magic-string';
import {
  type DevEnvironment,
  type EnvironmentModuleNode,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
  version as viteVersion,
} from 'vite';
import { createBridge, type OverlayOptions } from './bridge.js';
import { FileMap } from './file-map.js';
import { fsUrl, insideProject } from './next-paths.js';
import { hotReloadable, overlayFile, resolveOverlay } from './overlay-resolve.js';
import { type AstroCompiler, injectAstroSourceLocations } from './transform-astro-srcloc.js';
import { injectSourceLocations } from './transform-srcloc.js';
import { injectSvelteSourceLocations, type SvelteCompiler } from './transform-svelte-srcloc.js';
import { injectVueSourceLocations, type VueSfcCompiler } from './transform-vue-srcloc.js';
import { noticeUpdate } from './update-check.js';
import { createUpdateTracker, isUpdateResult } from './update-tracker.js';

export type { GuijamMessage, UpdateResult } from '@guijam/contracts-ts';

export interface GuijamOptions {
  daemonBinary?: string;
  root?: string;
}

export type { OverlayOptions } from './bridge.js';

export interface GuijamApi {
  setOverlay(file: string, content: string, options?: OverlayOptions): Promise<UpdateResult>;
  clearOverlay(file: string, options?: OverlayOptions): Promise<UpdateResult>;
  request(message: unknown): Promise<GuijamMessage>;
}

const CLIENT_ID = 'virtual:guijam/client';
const CLIENT_ENTRY = normalizePath(fileURLToPath(new URL('./client.js', import.meta.url)));
const WIDGET_URL = '/@guijam/widget.js';
const WIDGET_FILE = fileURLToPath(new URL('./widget.js', import.meta.url));
const UPDATE_TIMEOUT_MS = 3000;
const JSX_MODULE = /\.[jt]sx$/;
const VUE_MODULE = /\.vue$/;
const SVELTE_MODULE = /\.svelte$/;
const ASTRO_MODULE = /\.astro$/;
const SERVER_RENDERED = ASTRO_MODULE;
const FRAMEWORKS: readonly { plugin: string; entry?: RegExp }[] = [
  {
    plugin: 'vite-plugin-sveltekit',
    entry: /\/@sveltejs\/kit\/src\/runtime\/client\/entry\.js$/,
  },
  { plugin: 'react-router', entry: /\/entry\.client\.[cm]?[jt]sx?$/ },
  { plugin: 'solid-start', entry: /\/entry-client\.[cm]?[jt]sx?$/ },
  { plugin: 'astro:' },
];
const ASSET_FILE = /\.(?:svg|webp|png|jpe?g|gif|avif|ico)$/i;
const SCRIPT_MODULE = /\.[cm]?[jt]sx?$/;
const CLIENT_IMPORT = `import '${CLIENT_ID}';\n`;
const CSS_ID = /\.css(?:\?.*)?$/;
const NON_STYLESHEET_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;
const TAILWIND_ROOT = /@import\s+["']tailwindcss["']|@tailwind\s+utilities/;
const PLUGIN_VERSION = readPluginVersion();

function readPluginVersion(): string {
  const manifest: unknown = createRequire(import.meta.url)('../package.json');
  const version = (manifest as { version?: unknown }).version;
  return typeof version === 'string' ? version : '0.0.0';
}

function scriptEntriesOf(config: ResolvedConfig): Set<string> {
  const input = config.build.rolldownOptions?.input ?? config.build.rollupOptions?.input;
  const files =
    typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input ?? {});
  return new Set(
    files
      .filter((file) => SCRIPT_MODULE.test(file))
      .map((file) => normalizePath(resolve(config.root, file))),
  );
}

interface RunnerModules {
  getModuleById(id: string): object | undefined;
  invalidateModule(node: object): void;
}

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

export function guijam(options: GuijamOptions = {}): Plugin<GuijamApi> {
  const overlays = new FileMap<string>();
  const settled = new FileMap<string>();
  const serverSettled = new FileMap<string>();
  const tailwindRootIds = new Set<string>();
  const tracker = createUpdateTracker(UPDATE_TIMEOUT_MS);
  let devServer: ViteDevServer | undefined;
  let root = process.cwd();
  let viteRoot = process.cwd();
  let frameworkClientEntry: RegExp | undefined;
  let publicDir = join(process.cwd(), 'public');
  let candidatesDir = '';
  let scriptEntries = new Set<string>();
  const bridge = createBridge({
    root: () => root,
    daemonBinary: options.daemonBinary,
    logger: {
      info: (message) => devServer?.config.logger.info(message, { timestamp: true }),
      warn: (message) => devServer?.config.logger.warn(message),
    },
    hello: () => ({
      type: 'plugin.hello',
      payload: {
        pluginVersion: PLUGIN_VERSION,
        viteVersion,
        root,
        tailwindRoots: tailwindRootFiles(),
      },
    }),
    applyOverlay,
  });
  const { pages } = bridge;

  const compilers = new Map<string, Promise<((...args: never[]) => unknown) | null>>();

  function loadParser(
    specifier: string,
    via?: string,
  ): Promise<((...args: never[]) => unknown) | null> {
    let loading = compilers.get(specifier);
    if (!loading) {
      loading = (async () => {
        try {
          const project = createRequire(join(root, 'package.json'));
          const from =
            via === undefined ? project : createRequire(project.resolve(`${via}/package.json`));
          const entry = from.resolve(specifier);
          const loaded = (await import(pathToFileURL(entry).href)) as {
            parse?: (...args: never[]) => unknown;
            default?: { parse?: (...args: never[]) => unknown };
          };
          return loaded.parse ?? loaded.default?.parse ?? null;
        } catch (error) {
          devServer?.config.logger.warn(
            `[guijam] could not load ${specifier}, so its files have no source locations: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      })();
      compilers.set(specifier, loading);
    }
    return loading;
  }

  function modulesOfFile(environment: DevEnvironment, id: string): Set<EnvironmentModuleNode> {
    const graph = environment.moduleGraph;
    const found = graph.getModulesByFile(id);
    if ((found && found.size > 0) || process.platform !== 'win32' || !existsSync(id)) {
      return found ?? new Set();
    }
    return graph.getModulesByFile(normalizePath(realpathSync.native(id))) ?? new Set();
  }

  function tailwindRootFiles(): string[] {
    return [...new Set([...tailwindRootIds].map((id) => id.split('?', 1)[0] ?? id))];
  }

  async function syncCandidates(id: string, content: string | undefined): Promise<void> {
    const name = (insideProject(root, id) ?? id).replaceAll(/[\\/:]/g, '__');
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

  function serverEnvironments(): DevEnvironment[] {
    return Object.values(devServer?.environments ?? {}).filter(
      (environment) => environment.name !== 'client',
    );
  }

  function invalidateServerModules(environment: DevEnvironment, id: string): void {
    const invalidated = new Set<EnvironmentModuleNode>();
    for (const mod of modulesOfFile(environment, id)) {
      environment.moduleGraph.invalidateModule(mod, invalidated, Date.now(), true);
    }
    const evaluated = (environment as { runner?: { evaluatedModules?: RunnerModules } }).runner
      ?.evaluatedModules;
    if (!evaluated) return;
    for (const mod of invalidated) {
      const node = mod.id === null ? undefined : evaluated.getModuleById(mod.id);
      if (node) evaluated.invalidateModule(node);
    }
  }

  async function reloadTracked(
    client: DevEnvironment,
    reloads: readonly EnvironmentModuleNode[],
    updateId: string,
  ): Promise<UpdateResult> {
    const result = tracker.begin(updateId);
    client.hot.send('gj:update-start', {
      updateId,
      urls: reloads.map((mod) => mod.url),
      expectedUpdates: reloads.length,
    });
    for (const mod of reloads) await client.reloadModule(mod);
    return result;
  }

  async function showServerRendered(
    id: string,
    content: string | undefined,
    previous: string | undefined,
    onDisk: string | undefined,
    pageReload: boolean,
    updateId: string,
  ): Promise<UpdateResult> {
    const client = devServer?.environments.client;
    const ok: UpdateResult = { updateId, status: 'ok', latencyMs: 0, errors: [] };
    if (!client) return ok;
    for (const environment of serverEnvironments()) invalidateServerModules(environment, id);
    await syncCandidates(id, content);
    if ((previous ?? onDisk) === (content ?? onDisk)) return ok;
    const styles = tailwindRootModules(client);
    if (pageReload) {
      for (const mod of styles) client.moduleGraph.invalidateModule(mod);
      pages.reloading();
      client.hot.send({ type: 'full-reload', path: '*' });
      return { ...ok, status: 'full_reload' };
    }
    if (content === undefined || styles.length === 0) return ok;
    return reloadTracked(client, styles, updateId);
  }

  async function applyOverlay(
    file: string,
    content: string | undefined,
    options: OverlayOptions = {},
  ): Promise<UpdateResult> {
    if (!devServer) throw new Error('guijam: the Vite dev server has not started');
    const client = devServer.environments.client;
    const id = normalizePath(resolve(root, file));
    const updateId = randomUUID();
    const startedAt = performance.now();
    const onDisk = !ASSET_FILE.test(id) && existsSync(id) ? await readFile(id, 'utf8') : undefined;
    const previous = overlays.get(id);
    const unchanged = content === undefined && previous !== undefined && previous === onDisk;
    const reshown = content !== undefined && content === previous;
    if (content === undefined) overlays.delete(id);
    else overlays.set(id, content);
    if (unchanged) settled.set(id, previous);
    else settled.delete(id);
    if (SERVER_RENDERED.test(id) && unchanged) serverSettled.set(id, previous);
    else serverSettled.delete(id);
    const modules = [...modulesOfFile(client, id)];
    if (SERVER_RENDERED.test(id)) {
      return showServerRendered(
        id,
        content,
        previous,
        onDisk,
        options.pageReload ?? true,
        updateId,
      );
    }

    if (
      ASSET_FILE.test(id) ||
      (content === undefined && onDisk === undefined) ||
      unchanged ||
      reshown
    ) {
      for (const mod of modules) client.moduleGraph.invalidateModule(mod);
      await syncCandidates(id, content);
      return { updateId, status: 'ok', latencyMs: 0, errors: [] };
    }

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
    if (modules.length === 0) return { updateId, status: 'ok', latencyMs: 0, errors: [] };

    const reloads = [
      ...(content === undefined ? [] : tailwindRootModules(client)),
      ...modules.filter((mod) => hotReloadable(mod.url)),
    ];
    return reloadTracked(client, reloads, updateId);
  }

  const plugin: Plugin<GuijamApi> = {
    name: 'guijam',
    apply: 'serve',
    enforce: 'pre',

    api: {
      setOverlay: (file, content, options) => applyOverlay(file, content, options),
      clearOverlay: (file, options) => applyOverlay(file, undefined, options),
      request: (message) => bridge.relay(message),
    },

    async hotUpdate({ file, modules }) {
      const id = normalizePath(file);
      const server = this.environment.name !== 'client';
      if (server && !SERVER_RENDERED.test(id)) return;
      if (overlays.has(id)) return [];
      const shownFiles = server ? serverSettled : settled;
      const shown = shownFiles.get(id);
      if (shown === undefined) return;
      const disk = existsSync(id) ? await readFile(id, 'utf8') : undefined;
      if (disk === shown) {
        if (server) invalidateServerModules(this.environment, id);
        return [];
      }
      shownFiles.delete(id);
      if (server || disk === undefined) return;
      for (const mod of modules.filter((entry) => hotReloadable(entry.url))) {
        await this.environment.reloadModule(mod);
      }
      return [];
    },

    config() {
      return { server: { watch: { ignored: ['**/.guijam/**'] } } };
    },

    configResolved(config) {
      const framework = FRAMEWORKS.find(({ plugin: name }) =>
        config.plugins.some((entry) => entry.name.startsWith(name)),
      );
      frameworkClientEntry = framework?.entry;
      if (framework) delete plugin.transformIndexHtml;
      viteRoot = config.root;
      root = options.root === undefined ? config.root : normalizePath(resolve(options.root));
      publicDir = config.publicDir || join(viteRoot, 'public');
      candidatesDir = join(root, '.guijam', 'run', 'candidates');
      scriptEntries = scriptEntriesOf(config);
    },

    async configureServer(server) {
      if (server.config.build.ssr) return;
      devServer = server;
      await mkdir(candidatesDir, { recursive: true });
      server.environments.client.hot.on('gj:update-result', (data) => {
        if (isUpdateResult(data)) tracker.settle(data);
      });
      server.middlewares.use((request, response, next) => {
        const [pathname = '', search = ''] = (request.url ?? '').split('?', 2);
        if (!ASSET_FILE.test(pathname) || /(?:^|&)import\b/.test(search)) return next();
        const local = decodeURIComponent(pathname).replace(/^\/+/, '');
        const file = [resolve(viteRoot, local), resolve(publicDir, local), resolve(root, local)]
          .map(normalizePath)
          .find((candidate) => overlays.has(candidate));
        const content = file === undefined ? undefined : overlays.get(file);
        if (content === undefined) return next();
        response.setHeader('Content-Type', 'image/svg+xml');
        response.setHeader('Cache-Control', 'no-store');
        response.end(content);
      });
      server.middlewares.use(WIDGET_URL, (_request, response, next) => {
        readFile(WIDGET_FILE).then((body) => {
          response.setHeader('Content-Type', 'text/javascript');
          response.setHeader('Cache-Control', 'no-store');
          response.end(body);
        }, next);
      });
      server.environments.client.hot.on('gj:reloading', () => pages.reloading());
      server.environments.client.hot.on('vite:client:disconnect', (_data, client) => {
        pages.left(client);
      });
      server.environments.client.hot.on('gj:request', (raw, client) => bridge.handle(raw, client));
      const stop = bridge.connect();
      if (stop) server.httpServer?.once('close', stop);
      void noticeUpdate({
        root,
        version: PLUGIN_VERSION,
        log: (line) => server.config.logger.info(line, { timestamp: true }),
      });
    },

    resolveId(source, importer) {
      if (source === CLIENT_ID) return CLIENT_ENTRY;
      return resolveOverlay(source, importer, {
        root: viteRoot,
        has: (id) => overlays.has(id),
        onDisk: (id) => existsSync(id),
      });
    },

    load(id) {
      const file = id.split('?', 1)[0] ?? id;
      if (ASSET_FILE.test(file) && overlays.has(file)) {
        const inside = insideProject(viteRoot, file);
        const url = inside === undefined ? fsUrl(file) : `/${inside}`;
        return `export default ${JSON.stringify(url)};`;
      }
      return overlays.get(overlayFile(id)) ?? null;
    },

    transform: {
      order: 'pre',
      async handler(code, id) {
        const file = id.split('?', 1)[0] ?? id;
        const entry = scriptEntries.has(file) || frameworkClientEntry?.test(file) === true;
        const prepend = this.environment.name === 'client' && entry ? CLIENT_IMPORT : '';
        if (VUE_MODULE.test(id)) {
          const projectPath = insideProject(root, id);
          if (projectPath === undefined || id.includes('/node_modules/')) return null;
          const parse = await loadParser('vue/compiler-sfc');
          return parse
            ? injectVueSourceLocations(code, id, projectPath, {
                parse,
              } as unknown as VueSfcCompiler)
            : null;
        }
        if (SVELTE_MODULE.test(id)) {
          const projectPath = insideProject(root, id);
          if (projectPath === undefined || id.includes('/node_modules/')) return null;
          const parse = await loadParser('svelte/compiler');
          return parse
            ? injectSvelteSourceLocations(code, id, projectPath, {
                parse,
              } as unknown as SvelteCompiler)
            : null;
        }
        if (ASTRO_MODULE.test(id)) {
          const projectPath = insideProject(root, id);
          if (projectPath === undefined || id.includes('/node_modules/')) return null;
          const parse = await loadParser('@astrojs/compiler-rs', 'astro');
          return parse
            ? injectAstroSourceLocations(code, id, projectPath, {
                parse,
              } as unknown as AstroCompiler)
            : null;
        }
        if (JSX_MODULE.test(id)) {
          const projectPath = insideProject(root, file);
          if (projectPath !== undefined && !id.includes('/node_modules/')) {
            return injectSourceLocations(code, id, projectPath, prepend);
          }
          if (prepend === '') return null;
        }
        if (prepend !== '') {
          const output = new MagicString(code).prepend(prepend);
          return {
            code: output.toString(),
            map: output.generateMap({ source: id, includeContent: true, hires: 'boundary' }),
          };
        }
        if (!CSS_ID.test(id) || NON_STYLESHEET_QUERY.test(id) || !TAILWIND_ROOT.test(code)) {
          return null;
        }
        if (this.environment.name === 'client' && !tailwindRootIds.has(id)) {
          tailwindRootIds.add(id);
          bridge.notify({ type: 'tailwind.roots', payload: { files: tailwindRootFiles() } });
        }
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
  return plugin;
}
