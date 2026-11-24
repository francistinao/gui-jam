import { randomUUID } from 'node:crypto';
import type { GuijamMessage, UpdateResult } from '@guijam/contracts-ts';
import { findDaemonBinary, platformKey } from './daemon-binary.js';
import { DaemonClient, DaemonUnavailableError } from './daemon-client.js';
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

export interface OverlayOptions {
  pageReload?: boolean;
}

export interface PageClient {
  send(event: string, payload?: unknown): void;
}

export interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface BridgeOptions {
  root(): string;
  daemonBinary: string | undefined;
  logger: BridgeLogger;
  hello(): GuijamMessage;
  applyOverlay(
    file: string,
    content: string | undefined,
    options: OverlayOptions,
  ): Promise<UpdateResult>;
}

export interface Bridge {
  readonly pages: Pages<PageClient>;
  connect(): (() => void) | undefined;
  notify(message: GuijamMessage): void;
  relay(data: unknown): Promise<GuijamMessage>;
  handle(raw: unknown, client: PageClient): Promise<void>;
}

function overlayOptions(pageReload: boolean | undefined): OverlayOptions {
  return pageReload === undefined ? {} : { pageReload };
}

export function createBridge(options: BridgeOptions): Bridge {
  const { logger } = options;
  let daemon: DaemonClient | undefined;
  const socketIds = new WeakMap<PageClient, string>();

  const reportFailure = (what: string) => (error: unknown) => {
    logger.warn(`[guijam] ${what}: ${error instanceof Error ? error.message : String(error)}`);
  };

  const pages = new Pages<PageClient>(
    (runId) => {
      if (!daemon) return;
      for (const type of ['generate.cancel', 'generate.discard'] as const) {
        daemon
          .request({ type, payload: { runId } })
          .catch(reportFailure(`could not drop run ${runId} of a closed page`));
      }
    },
    (runId) =>
      daemon
        ?.request({ type: 'preview.release', payload: { runId } })
        .catch(reportFailure(`could not release the preview of run ${runId}`)),
  );

  function socketId(client: PageClient): string {
    const known = socketIds.get(client);
    if (known) return known;
    const id = `socket-${randomUUID()}`;
    socketIds.set(client, id);
    return id;
  }

  async function answer(message: GuijamMessage): Promise<GuijamMessage | undefined> {
    switch (message.type) {
      case 'overlay.set':
        return {
          type: 'update.result',
          payload: await options.applyOverlay(
            message.payload.file,
            message.payload.content,
            overlayOptions(message.payload.pageReload),
          ),
        };
      case 'overlay.clear':
        return {
          type: 'update.result',
          payload: await options.applyOverlay(
            message.payload.file,
            undefined,
            overlayOptions(message.payload.pageReload),
          ),
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
      if (line) logger.info(`[guijam] ${line}`);
      return { ...reply, id };
    } catch (error) {
      return errorReply(
        'DAEMON_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        id,
        (error instanceof DaemonUnavailableError ? error.action : undefined) ??
          'Check `gjd daemon status`, then retry.',
      );
    }
  }

  async function handle(raw: unknown, client: PageClient): Promise<void> {
    const { pageId, reloaded, data } = splitPage(raw, socketId(client));
    await pages.seen(client, pageId, reloaded);
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
  }

  function connect(): (() => void) | undefined {
    const binary = findDaemonBinary(options.daemonBinary);
    if (!binary) {
      logger.warn(
        `[guijam] fine-tune and AI edits are off: no gjd binary for ${platformKey()}. Reinstall guijam, or set GUIJAM_GJD_BIN to a gjd binary.`,
      );
      return undefined;
    }
    const client = new DaemonClient({
      root: options.root(),
      binary,
      hello: options.hello,
      onMessage: answer,
      onConnectionChange: (connected) => {
        if (!connected) logger.warn('[guijam] daemon disconnected; reconnecting');
      },
      onUnavailable: (reason) => logger.warn(`[guijam] daemon unavailable: ${reason}`),
    });
    client.start();
    daemon = client;
    return () => client.stop();
  }

  return {
    pages,
    connect,
    notify: (message) => daemon?.notify(message),
    relay,
    handle,
  };
}
