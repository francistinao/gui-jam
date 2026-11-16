import type { ErrorCode, GuijamMessage } from '@guijam/contracts-ts';

const WIDGET_REQUEST_TYPES = [
  'element.inspect',
  'finetune.preview',
  'changeset.commit',
  'changeset.discard',
  'journal.undo',
  'generate.request',
  'generate.cancel',
] as const satisfies readonly GuijamMessage['type'][];

/** The daemon gives a provider 60 s (route R1), then previews the variant. */
const GENERATION_REPLY_MS = 90_000;

/** How long to wait for the daemon's reply, or undefined for the default. */
export function replyWindowMs(type: GuijamMessage['type']): number | undefined {
  return type === 'generate.request' ? GENERATION_REPLY_MS : undefined;
}

type WidgetRequestType = (typeof WIDGET_REQUEST_TYPES)[number];

/** A request the widget may send. Its payload is validated by the daemon. */
export interface WidgetRequest {
  type: WidgetRequestType;
  id: string;
  payload: object;
}

function isWidgetRequestType(value: unknown): value is WidgetRequestType {
  return WIDGET_REQUEST_TYPES.some((type) => type === value);
}

export function errorReply(
  code: ErrorCode,
  message: string,
  id: string | undefined,
  action?: string,
): GuijamMessage {
  const payload = action === undefined ? { code, message } : { code, message, action };
  return id === undefined ? { type: 'error', payload } : { type: 'error', id, payload };
}

export type WidgetRequestCheck =
  | { ok: true; message: WidgetRequest }
  | { ok: false; reply: GuijamMessage };

/**
 * Admits only the request types the widget may send, each with an id for its reply.
 */
export function checkWidgetRequest(data: unknown): WidgetRequestCheck {
  if (typeof data !== 'object' || data === null) {
    return {
      ok: false,
      reply: errorReply('INVALID_REQUEST', 'requests must be objects', undefined),
    };
  }
  const candidate = data as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id : undefined;
  const { type, payload } = candidate;
  if (id === undefined || !isWidgetRequestType(type)) {
    return {
      ok: false,
      reply: errorReply('INVALID_REQUEST', 'unknown widget request', id),
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reply: errorReply('INVALID_REQUEST', 'the request has no payload', id) };
  }
  return { ok: true, message: { type, id, payload } };
}

/** The Vite terminal line for a reply worth announcing (F-DX-06), if any. */
export function terminalLine(reply: GuijamMessage): string | undefined {
  switch (reply.type) {
    case 'commit.done':
      return `✎ ${reply.payload.summary}`;
    case 'undo.done':
      return `↺ undid ${reply.payload.undoOf}`;
    default:
      return undefined;
  }
}
