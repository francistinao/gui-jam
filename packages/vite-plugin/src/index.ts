import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { DaemonClient } from './daemon-client.js';
import { checkWidgetRequest, errorReply, replyWindowMs, terminalLine } from './relay.js';
import { injectSourceLocations } from './transform-srcloc.js';
import { createUpdateTracker, isUpdateResult } from './update-tracker.js';

export type { GuijamMessage, UpdateResult } from '@guijam/contracts-ts';

export interface GuijamOptions {
  /** The `gjd` binary that runs the project daemon. Defaults to `$GUIJAM_GJD_BIN`. */
  daemonBinary?: string;
}

export interface GuijamApi {
  /**
   * Serves `content` in place of `file` (absolute or relative to the Vite root) without
   * touching the source file. Content that does not compile is rejected with
   * `compile_error` and the previous state is kept.
   */
  setOverlay(file: string, content: string): Promise<UpdateResult>;
  /** Drops the overlay so the module is served from disk again. */
  clearOverlay(file: string): Promise<UpdateResult>;
  /** Sends a widget request to the daemon, exactly as the browser widget does. */
  request(message: unknown): Promise<GuijamMessage>;
}

const CLIENT_ID = 'virtual:guijam/client';
const CLIENT_ENTRY = normalizePath(fileURLToPath(new URL('./client.js', import.meta.url)));
const WIDGET_URL = '/@guijam/widget.js';
const WIDGET_FILE = fileURLToPath(new URL('./widget.js', import.meta.url));
const UPDATE_TIMEOUT_MS = 3000;
const JSX_MODULE = /\.[jt]sx$/;
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

/**
 * Script entries named in the build input. Backend-served pages (Laravel's `@vite`,
 * Inertia) load these directly, so `transformIndexHtml` never runs for them.
 */
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

export function guijam(options: GuijamOptions = {}): Plugin<GuijamApi> {
  const overlays = new Map<string, string>();
  const tailwindRootIds = new Set<string>();
  const tracker = createUpdateTracker(UPDATE_TIMEOUT_MS);
  let devServer: ViteDevServer | undefined;
  let daemon: DaemonClient | undefined;
  let root = process.cwd();
  let candidatesDir = '';
  let scriptEntries = new Set<string>();

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
    const binary = options.daemonBinary ?? process.env.GUIJAM_GJD_BIN;
    if (!binary) {
      logger.warn('[guijam] fine-tune and AI edits are off: set GUIJAM_GJD_BIN to the gjd binary');
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
      request: (message) => relay(message),
    },

    config() {
      return { server: { watch: { ignored: ['**/.guijam/**'] } } };
    },

    configResolved(config) {
      root = config.root;
      candidatesDir = join(root, '.guijam', 'run', 'candidates');
      scriptEntries = scriptEntriesOf(config);
    },

    async configureServer(server) {
      devServer = server;
      await mkdir(candidatesDir, { recursive: true });
      server.environments.client.hot.on('gj:update-result', (data) => {
        if (isUpdateResult(data)) tracker.settle(data);
      });
      // The widget is one prebuilt module; serving it as is keeps it out of Vite's pipeline.
      server.middlewares.use(WIDGET_URL, (_request, response, next) => {
        readFile(WIDGET_FILE).then((body) => {
          response.setHeader('Content-Type', 'text/javascript');
          response.setHeader('Cache-Control', 'no-store');
          response.end(body);
        }, next);
      });
      server.environments.client.hot.on('gj:request', async (data, client) => {
        client.send('gj:response', await relay(data));
      });
      connectDaemon(server);
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
        const prepend =
          this.environment.name === 'client' && scriptEntries.has(id.split('?', 1)[0] ?? id)
            ? CLIENT_IMPORT
            : '';
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
}
