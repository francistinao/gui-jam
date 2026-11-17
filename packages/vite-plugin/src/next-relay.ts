import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { type AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateResult } from '@guijam/contracts-ts';
import { type WebSocket, WebSocketServer } from 'ws';
import { createBridge, type PageClient } from './bridge.js';
import { candidatesDirOf, overlayFileOf, runDir, TAILWIND_ROOT, toPosix } from './next-paths.js';

export interface NextRelayOptions {
  root: string;
  nextVersion: string;
  pluginVersion: string;
  daemonBinary?: string;
}

export interface NextRelay {
  url: string;
  widgetUrl: string;
}

interface RelayRecord extends NextRelay {
  pid: number;
}

const WIDGET_FILE = fileURLToPath(new URL('./widget.js', import.meta.url));
const SKIPPED_DIRS = new Set(['node_modules', '.next', '.git', '.guijam', 'dist', 'build', 'out']);
const MAX_SCAN_DEPTH = 6;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const relays = new Map<string, Promise<NextRelay>>();
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 50;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordFile(root: string): string {
  return join(runDir(root), 'next-relay.json');
}

function lockFile(root: string): string {
  return join(runDir(root), 'next-relay.lock');
}

function lockHolder(root: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockFile(root), 'utf8'), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function takeLock(root: string): Promise<boolean> {
  try {
    const handle = await open(lockFile(root), 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch {
    const holder = lockHolder(root);
    if (holder !== undefined && holder !== process.pid && isAlive(holder)) return false;
    await rm(lockFile(root), { force: true });
    return takeLock(root);
  }
}

async function answers(relay: NextRelay): Promise<boolean> {
  try {
    const health = new URL('/health', relay.widgetUrl);
    const response = await fetch(health, { signal: AbortSignal.timeout(1_000) });
    return response.status === 204;
  } catch {
    return false;
  }
}

async function liveRelay(root: string): Promise<NextRelay | undefined> {
  const running = runningRelay(root);
  return running && (await answers(running)) ? running : undefined;
}

async function waitForRelay(root: string): Promise<NextRelay | undefined> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const running = await liveRelay(root);
    if (running) return running;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  return undefined;
}

function runningRelay(root: string): NextRelay | undefined {
  const file = recordFile(root);
  if (!existsSync(file)) return undefined;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as Partial<RelayRecord>;
    if (typeof record.pid !== 'number' || record.pid === process.pid || !isAlive(record.pid)) {
      return undefined;
    }
    if (typeof record.url !== 'string' || typeof record.widgetUrl !== 'string') return undefined;
    return { url: record.url, widgetUrl: record.widgetUrl };
  } catch {
    return undefined;
  }
}

export function tailwindRootsIn(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path, depth + 1);
      } else if (entry.name.endsWith('.css') && statSync(path).size < 512_000) {
        if (TAILWIND_ROOT.test(readFileSync(path, 'utf8'))) found.push(path);
      }
    }
  };
  walk(root, 0);
  return found;
}

export function localOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === 'http:' || protocol === 'https:') && LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function socketClient(socket: WebSocket): PageClient {
  return {
    send(event, payload) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event, data: payload }));
    },
  };
}

async function serve(options: NextRelayOptions): Promise<NextRelay> {
  const { root } = options;
  const token = randomUUID();
  await mkdir(join(runDir(root), 'overlays'), { recursive: true });
  await mkdir(candidatesDirOf(root), { recursive: true });

  async function applyOverlay(file: string, content: string | undefined): Promise<UpdateResult> {
    const projectPath = toPosix(file);
    await writeFile(overlayFileOf(root, projectPath), content ?? '');
    const candidates = join(candidatesDirOf(root), projectPath.replaceAll('/', '__'));
    await writeFile(candidates, content ?? '');
    return { updateId: randomUUID(), status: 'ok', latencyMs: 0, errors: [] };
  }

  const bridge = createBridge({
    root: () => root,
    daemonBinary: options.daemonBinary,
    logger: {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
    },
    hello: () => ({
      type: 'plugin.hello',
      payload: {
        pluginVersion: options.pluginVersion,
        viteVersion: `next ${options.nextVersion}`,
        root,
        tailwindRoots: tailwindRootsIn(root),
      },
    }),
    applyOverlay,
  });

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }
    if (request.method === 'GET' && request.url === '/widget.js') {
      readFile(WIDGET_FILE).then(
        (body) => {
          response.writeHead(200, {
            'Content-Type': 'text/javascript',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          response.end(body);
        },
        () => response.writeHead(500).end(),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay');
    if (
      url.pathname !== '/socket' ||
      url.searchParams.get('token') !== token ||
      !localOrigin(request.headers.origin)
    ) {
      socket.destroy();
      return;
    }
    if (socket instanceof Socket) socket.unref();
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const client = socketClient(ws);
      ws.on('message', (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        const { event, data } = (parsed ?? {}) as { event?: unknown; data?: unknown };
        if (event === 'gj:request') void bridge.handle(data, client);
      });
      ws.on('close', () => bridge.pages.left(client));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const { port } = server.address() as AddressInfo;
  const relay: NextRelay = {
    url: `ws://127.0.0.1:${port}/socket?token=${token}`,
    widgetUrl: `http://127.0.0.1:${port}/widget.js`,
  };
  const stop = bridge.connect();
  process.once('exit', () => stop?.());
  const record: RelayRecord = { ...relay, pid: process.pid };
  await writeFile(recordFile(root), JSON.stringify(record));
  return relay;
}

async function claim(options: NextRelayOptions): Promise<NextRelay> {
  const { root } = options;
  await mkdir(runDir(root), { recursive: true });
  for (;;) {
    const running = await liveRelay(root);
    if (running) return running;
    if (await takeLock(root)) {
      const again = await liveRelay(root);
      return again ?? serve(options);
    }
    const started = await waitForRelay(root);
    if (started) return started;
  }
}

export function startNextRelay(options: NextRelayOptions): Promise<NextRelay> {
  let relay = relays.get(options.root);
  if (!relay) {
    relay = claim(options);
    relays.set(options.root, relay);
  }
  return relay;
}
