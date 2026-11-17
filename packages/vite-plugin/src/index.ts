import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import { findDaemonBinary, platformKey } from './daemon-binary.js';
import { DaemonClient } from './daemon-client.js';
import { hotReloadable, resolveOverlay } from './overlay-resolve.js';
import { Pages } from './pages.js';
import {
  checkWidgetRequest,
  errorReply,
  generationRunId,
  replyWindowMs,
  requestId,
  requestRunId,
  splitPage,
  terminalLine,
} from './relay.js';
import { injectSourceLocations } from './transform-srcloc.js';
import { injectSvelteSourceLocations, type SvelteCompiler } from './transform-svelte-srcloc.js';
import { injectVueSourceLocations, type VueSfcCompiler } from './transform-vue-srcloc.js';
import { createUpdateTracker, isUpdateResult } from './update-tracker.js';

export type { GuijamMessage, UpdateResult } from '@guijam/contracts-ts';

export interface GuijamOptions {
  daemonBinary?: string;
  root?: string;
}

export interface GuijamApi {
  setOverlay(file: string, content: string): Promise<UpdateResult>;
  clearOverlay(file: string): Promise<UpdateResult>;
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
const SVELTEKIT_CLIENT_ENTRY = /\/@sveltejs\/kit\/src\/runtime\/client\/entry\.js$/;
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

interface PageClient {
  send(event: string, payload?: unknown): void;
}

export function guijam(options: GuijamOptions = {}): Plugin<GuijamApi> {
  const overlays = new Map<string, string>();
  const settled = new Map<string, string>();
  const tailwindRootIds = new Set<string>();
  const tracker = createUpdateTracker(UPDATE_TIMEOUT_MS);
  let devServer: ViteDevServer | undefined;
  let daemon: DaemonClient | undefined;
  let root = process.cwd();
  let viteRoot = process.cwd();
  let sveltekit = false;
  let publicDir = join(process.cwd(), 'public');
  let candidatesDir = '';
  let scriptEntries = new Set<string>();
  const pages = new Pages<PageClient>(dropRun, releaseRun);
  const socketIds = new WeakMap<PageClient, string>();

  function dropRun(runId: string): void {
    if (!daemon) return;
    for (const type of ['generate.cancel', 'generate.discard'] as const) {
      daemon.request({ type, payload: { runId } }).catch((error: unknown) => {
        devServer?.config.logger.warn(
          `[guijam] could not drop run ${runId} of a closed page: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  function releaseRun(runId: string): void {
    daemon?.request({ type: 'preview.release', payload: { runId } }).catch((error: unknown) => {
      devServer?.config.logger.warn(
        `[guijam] could not release the preview of run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  const compilers = new Map<string, Promise<((...args: never[]) => unknown) | null>>();

  function loadParser(specifier: string): Promise<((...args: never[]) => unknown) | null> {
    let loading = compilers.get(specifier);
    if (!loading) {
      loading = (async () => {
        try {
          const entry = createRequire(join(root, 'package.json')).resolve(specifier);
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

  function socketId(client: PageClient): string {
    const known = socketIds.get(client);
    if (known) return known;
    const id = `socket-${randomUUID()}`;
    socketIds.set(client, id);
    return id;
  }

  function tailwindRootFiles(): string[] {
    return [...new Set([...tailwindRootIds].map((id) => id.split('?', 1)[0] ?? id))];
  }

  async function answerDaemon(message: GuijamMessage): Promise<GuijamMessage | undefined> {
    switch (message.type) {
      case 'overlay.set':
        return {
          type: 'update.result',
          payload: await applyOverlay(message.payload.file, message.payload.content),
        };
      case 'overlay.clear':
        return {
          type: 'update.result',
          payload: await applyOverlay(message.payload.file, undefined),
        };
      case 'generate.progress':
        pages.client(message.payload.runId)?.send('gj:event', message);
        return undefined;
      default:
        return undefined;
    }
  }

  async function relay(data: unknown): Promise<GuijamMessage> {
    const checked = checkWidgetRequest(data);
    if (!checked.ok) return checked.reply;
    const { id } = checked.message;
    if (!daemon) {
      return errorReply(
        'DAEMON_UNAVAILABLE',
        'This dev server runs without the GUIJam daemon.',
        id,
        'Set GUIJAM_GJD_BIN to the gjd binary, then restart the dev server.',
      );
    }
    try {
      const reply = await daemon.request(checked.message, replyWindowMs(checked.message.type));
      const line = terminalLine(reply);
      if (line) devServer?.config.logger.info(`[guijam] ${line}`, { timestamp: true });
      return { ...reply, id };
    } catch (error) {
      return errorReply(
        'DAEMON_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        id,
        'Check `gjd daemon status`, then retry.',
      );
    }
  }

  function connectDaemon(server: ViteDevServer): void {
    const logger = server.config.logger;
    const binary = findDaemonBinary(options.daemonBinary);
    if (!binary) {
      logger.warn(
        `[guijam] fine-tune and AI edits are off: no gjd binary for ${platformKey()}. Reinstall guijam, or set GUIJAM_GJD_BIN to a gjd binary.`,
      );
      return;
    }
    const client = new DaemonClient({
      root,
      binary,
      hello: () => ({
        type: 'plugin.hello',
        payload: {
          pluginVersion: PLUGIN_VERSION,
          viteVersion,
          root,
          tailwindRoots: tailwindRootFiles(),
        },
      }),
      onMessage: answerDaemon,
      onConnectionChange: (connected) => {
        if (!connected) logger.warn('[guijam] daemon disconnected; reconnecting');
      },
      onUnavailable: (reason) => logger.warn(`[guijam] daemon unavailable: ${reason}`),
    });
    client.start();
    server.httpServer?.once('close', () => client.stop());
    daemon = client;
  }

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
    settled.delete(id);
    const modules = [...(client.moduleGraph.getModulesByFile(id) ?? [])];
    const onDisk = !ASSET_FILE.test(id) && existsSync(id) ? await readFile(id, 'utf8') : undefined;
    const unchanged = content === undefined && previous !== undefined && previous === onDisk;
    if (unchanged) settled.set(id, previous);

    if (ASSET_FILE.test(id) || (content === undefined && onDisk === undefined) || unchanged) {
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
    const result = tracker.begin(updateId);
    client.hot.send('gj:update-start', {
      updateId,
      urls: reloads.map((mod) => mod.url),
      expectedUpdates: reloads.length,
    });
    for (const mod of reloads) await client.reloadModule(mod);
    return result;
  }

  const plugin: Plugin<GuijamApi> = {
    name: 'guijam',
    apply: 'serve',
    enforce: 'pre',

    api: {
      setOverlay: (file, content) => applyOverlay(file, content),
      clearOverlay: (file) => applyOverlay(file, undefined),
      request: (message) => relay(message),
    },

    async hotUpdate({ file, read, modules }) {
      if (this.environment.name !== 'client') return;
      const id = normalizePath(file);
      if (overlays.has(id)) return [];
      const shown = settled.get(id);
      if (shown === undefined) return;
      settled.delete(id);
      if ((await read()) === shown) return [];
      for (const mod of modules.filter((entry) => hotReloadable(entry.url))) {
        await this.environment.reloadModule(mod);
      }
      return [];
    },

    config() {
      return { server: { watch: { ignored: ['**/.guijam/**'] } } };
    },

    configResolved(config) {
      sveltekit = config.plugins.some((entry) => entry.name.startsWith('vite-plugin-sveltekit'));
      if (sveltekit) delete plugin.transformIndexHtml;
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
      server.environments.client.hot.on('vite:client:disconnect', (_data, client) => {
        pages.left(client);
      });
      server.environments.client.hot.on('gj:request', async (raw, client) => {
        const { pageId, data } = splitPage(raw, socketId(client));
        pages.seen(client, pageId);
        const attaching = requestRunId(data, 'generate.attach');
        if (attaching !== undefined) {
          const kept = await pages.attach(attaching);
          const id = requestId(data);
          client.send(
            'gj:response',
            kept
              ? { ...kept, ...(id === undefined ? {} : { id }) }
              : errorReply(
                  'UNKNOWN_CHANGESET',
                  'This drawing stopped while the page was reloading.',
                  id,
                  'Generate it again.',
                ),
          );
          return;
        }
        const discarded = requestRunId(data, 'generate.discard');
        if (discarded !== undefined) pages.discarded(pageId, discarded);
        const reply = relay(data);
        const runId = generationRunId(data);
        if (runId !== undefined) pages.started(pageId, runId, reply);
        client.send('gj:response', await reply);
      });
      connectDaemon(server);
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
        const inside = relative(viteRoot, file);
        const url = inside.startsWith('..') ? `/@fs${file}` : `/${normalizePath(inside)}`;
        return `export default ${JSON.stringify(url)};`;
      }
      return overlays.get(id) ?? null;
    },

    transform: {
      order: 'pre',
      async handler(code, id) {
        const file = id.split('?', 1)[0] ?? id;
        const entry = scriptEntries.has(file) || (sveltekit && SVELTEKIT_CLIENT_ENTRY.test(file));
        const prepend = this.environment.name === 'client' && entry ? CLIENT_IMPORT : '';
        if (VUE_MODULE.test(id)) {
          const projectPath = normalizePath(relative(root, id));
          if (projectPath.startsWith('..') || id.includes('/node_modules/')) return null;
          const parse = await loadParser('vue/compiler-sfc');
          return parse
            ? injectVueSourceLocations(code, id, projectPath, {
                parse,
              } as unknown as VueSfcCompiler)
            : null;
        }
        if (SVELTE_MODULE.test(id)) {
          const projectPath = normalizePath(relative(root, id));
          if (projectPath.startsWith('..') || id.includes('/node_modules/')) return null;
          const parse = await loadParser('svelte/compiler');
          return parse
            ? injectSvelteSourceLocations(code, id, projectPath, {
                parse,
              } as unknown as SvelteCompiler)
            : null;
        }
        if (JSX_MODULE.test(id)) {
          const projectPath = normalizePath(relative(root, id));
          if (projectPath.startsWith('..') || id.includes('/node_modules/')) return null;
          return injectSourceLocations(code, id, projectPath, prepend);
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
          daemon?.notify({ type: 'tailwind.roots', payload: { files: tailwindRootFiles() } });
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
