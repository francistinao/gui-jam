import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GuijamMessage } from '@guijam/contracts-ts';

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15_000;
const SPAWN_WAIT_MS = 3_000;
const SPAWN_POLL_MS = 25;
const RECONNECT_MIN_MS = 100;
const RECONNECT_MAX_MS = 5_000;

interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  protocol: number;
}

export interface DaemonClientOptions {
  root: string;
  binary: string;
  /** Sent first on every connection, so a restarted daemon learns about the plugin. */
  hello(): GuijamMessage;
  /** A message the daemon sent; the returned message is sent back as its reply. */
  onMessage(message: GuijamMessage): Promise<GuijamMessage | undefined>;
  onConnectionChange(connected: boolean): void;
  /** Called once per outage with the reason the daemon cannot be reached. */
  onUnavailable(reason: string): void;
}

interface Pending {
  resolve(reply: GuijamMessage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class DaemonUnavailableError extends Error {}

/** Anything sent to the daemon; it validates every message against the protocol. */
export interface OutgoingMessage {
  type: string;
  payload: unknown;
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.pid === 'number' &&
    typeof info.port === 'number' &&
    typeof info.token === 'string' &&
    typeof info.protocol === 'number'
  );
}

function isMessage(value: unknown): value is GuijamMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { payload?: unknown }).payload === 'object'
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('connection refused')), {
      once: true,
    });
  });
}

/**
 * The Vite plugin's connection to `gjd`, which it starts when no daemon serves the
 * project yet and reconnects to after a restart.
 */
export class DaemonClient {
  readonly #options: DaemonClientOptions;
  readonly #infoPath: string;
  readonly #pending = new Map<string, Pending>();
  #socket: WebSocket | undefined;
  #nextId = 1;
  #reconnectMs = RECONNECT_MIN_MS;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #stopped = false;
  #outageReported = false;

  constructor(options: DaemonClientOptions) {
    this.#options = options;
    this.#infoPath = join(options.root, '.guijam', 'run', 'daemon.json');
  }

  start(): void {
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#failPending(new DaemonUnavailableError('the dev server is shutting down'));
  }

  /** Sends a message that expects no reply; dropped while disconnected. */
  notify(message: GuijamMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  /** Sends a request and resolves with the daemon's reply (which may be an `error`). */
  request(message: OutgoingMessage): Promise<GuijamMessage> {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new DaemonUnavailableError('the GUIJam daemon is not connected'));
    }
    const id = `p${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(`the daemon did not answer ${message.type} within ${REQUEST_TIMEOUT_MS} ms`),
        );
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...message, id }));
    });
  }

  async #connect(): Promise<void> {
    try {
      const info = await this.#daemonInfo();
      const socket = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, {
        headers: { Authorization: `Bearer ${info.token}` },
      });
      await opened(socket);
      if (this.#stopped) {
        socket.close();
        return;
      }
      this.#socket = socket;
      this.#reconnectMs = RECONNECT_MIN_MS;
      this.#outageReported = false;
      socket.addEventListener('message', (event) => void this.#receive(String(event.data)));
      socket.addEventListener('close', () => this.#lost());
      socket.send(JSON.stringify(this.#options.hello()));
      this.#options.onConnectionChange(true);
    } catch (error) {
      if (!this.#outageReported) {
        this.#outageReported = true;
        this.#options.onUnavailable(error instanceof Error ? error.message : String(error));
      }
      this.#scheduleReconnect();
    }
  }

  async #daemonInfo(): Promise<DaemonInfo> {
    const existing = await this.#readInfo();
    if (existing && isAlive(existing.pid)) return existing;
    await this.#spawnDaemon();
    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      const info = await this.#readInfo();
      if (info && info.pid !== existing?.pid) return info;
      await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
    }
    throw new DaemonUnavailableError(`gjd did not start within ${SPAWN_WAIT_MS} ms`);
  }

  async #readInfo(): Promise<DaemonInfo | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#infoPath, 'utf8'));
      return isDaemonInfo(parsed) && parsed.protocol === PROTOCOL_VERSION ? parsed : undefined;
    } catch {
      // Missing or half-written daemon.json means no daemon is ready yet.
      return undefined;
    }
  }

  async #spawnDaemon(): Promise<void> {
    const logDir = join(this.#options.root, '.guijam', 'logs');
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const log = await open(join(logDir, 'gjd.log'), 'a', 0o600);
    try {
      const child = spawn(
        this.#options.binary,
        ['daemon', 'run', '--project', this.#options.root],
        { detached: true, stdio: ['ignore', log.fd, log.fd] },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  }

  async #receive(raw: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isMessage(message)) return;
    const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
    if (pending && message.id !== undefined) {
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    const reply = await this.#options.onMessage(message);
    if (reply && this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ ...reply, id: message.id }));
    }
  }

  #lost(): void {
    this.#socket = undefined;
    if (this.#stopped) return;
    this.#options.onConnectionChange(false);
    this.#failPending(new DaemonUnavailableError('the GUIJam daemon disconnected'));
    this.#scheduleReconnect();
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => void this.#connect(), this.#reconnectMs);
    this.#reconnectMs = Math.min(this.#reconnectMs * 2, RECONNECT_MAX_MS);
  }
}
