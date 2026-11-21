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
  'dependencies.install',
  'generate.discard',
  'tracker.status',
  'tracker.search',
  'tracker.ticket',
  'tracker.start',
  'tracker.post',
  'tracker.report',
] as const satisfies readonly GuijamMessage['type'][];

const GENERATION_REPLY_MS = 360_000;
const INSTALL_REPLY_MS = 270_000;
const TRACKER_REPLY_MS = 60_000;
const TRACKER_POST_REPLY_MS = 90_000;

export function replyWindowMs(type: GuijamMessage['type']): number | undefined {
  if (type === 'generate.request') return GENERATION_REPLY_MS;
  if (type === 'dependencies.install') return INSTALL_REPLY_MS;
  if (type === 'tracker.post' || type === 'tracker.report') return TRACKER_POST_REPLY_MS;
  if (type.startsWith('tracker.')) return TRACKER_REPLY_MS;
  return undefined;
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
    case 'tracker.posted':
      return reply.payload.outcome === 'posted'
        ? `⇪ posted to ${reply.payload.ref.key}`
        : `⇪ nothing posted to ${reply.payload.ref.key}: the change was undone`;
    case 'tracker.reported':
      return `⇪ created ${reply.payload.ref.key}`;
    default:
      return undefined;
  }
}

export function requestRunId(data: unknown, requestType: string): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, payload } = data as { type?: unknown; payload?: unknown };
  if (type !== requestType || typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const { runId } = payload as { runId?: unknown };
  return typeof runId === 'string' ? runId : undefined;
}

export function generationRunId(data: unknown): string | undefined {
  return requestRunId(data, 'generate.request');
}

export function requestId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { id } = data as { id?: unknown };
  return typeof id === 'string' ? id : undefined;
}

const PAGE_ID = /^[\w-]{1,100}$/;

export function splitPage(raw: unknown, fallback: string): { pageId: string; data: unknown } {
  if (typeof raw !== 'object' || raw === null || !('pageId' in raw)) {
    return { pageId: fallback, data: raw };
  }
  const { pageId, ...data } = raw as { pageId: unknown };
  return {
    pageId: typeof pageId === 'string' && PAGE_ID.test(pageId) ? pageId : fallback,
    data,
  };
}
