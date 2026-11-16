import type { ErrorCode, GuijamMessage } from '@guijam/contracts-ts';

const WIDGET_REQUEST_TYPES = [
  'element.inspect',
  'finetune.preview',
  'changeset.commit',
  'changeset.discard',
  'journal.undo',
  'generate.request',
  'generate.cancel',
  'variant.select',
  'generate.discard',
] as const satisfies readonly GuijamMessage['type'][];

const GENERATION_REPLY_MS = 150_000;

export function replyWindowMs(type: GuijamMessage['type']): number | undefined {
  return type === 'generate.request' ? GENERATION_REPLY_MS : undefined;
}

type WidgetRequestType = (typeof WIDGET_REQUEST_TYPES)[number];

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

export function terminalLine(reply: GuijamMessage): string | undefined {
  switch (reply.type) {
    case 'commit.done':
      return `✎ ${reply.payload.summary}`;
    case 'undo.done':
      return `↺ undid ${reply.payload.undoOf}`;
    case 'generate.done':
      return `✦ ${reply.payload.summary}`;
    default:
      return undefined;
  }
}

export function generationRunId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, payload } = data as { type?: unknown; payload?: unknown };
  if (type !== 'generate.request' || typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const { runId } = payload as { runId?: unknown };
  return typeof runId === 'string' ? runId : undefined;
}
