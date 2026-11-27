import type {
  SketchImage,
  TicketDetail,
  TicketImage,
  TicketRef,
  TicketTransition,
} from '@guijam/contracts-ts';

export const TICKET_PARAM = 'guijam-ticket';
export const MAX_PROMPT = 4000;
const TICKET_KEY = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

export interface TicketLoading {
  key: string;
  step: 'reading' | 'screenshot' | 'prompt';
  images: number;
  fills: boolean;
}

export function loadingMessage({ key, step, images, fills }: TicketLoading): string {
  if (step === 'reading') return `Reading ${key} from Jira…`;
  if (step === 'screenshot') return `Taking a before screenshot for ${key}…`;
  if (!fills) return `Linking ${key}…`;
  return images > 0
    ? `Adding ${key}'s text and ${images} image${images === 1 ? '' : 's'} to your prompt…`
    : `Adding ${key}'s text to your prompt…`;
}

export interface LinkedTicket {
  ref: TicketRef;
  summary: string;
  description: string;
  url: string;
  transitions: TicketTransition[];
  images: TicketImage[];
  before: SketchImage[];
  transitionId: string | null;
  screenshots: boolean;
}

export function isTicketKey(text: string): boolean {
  return TICKET_KEY.test(text.trim().toUpperCase());
}

export function linkedTicket(detail: TicketDetail, before: SketchImage[]): LinkedTicket {
  return {
    ref: detail.ref,
    summary: detail.summary,
    description: detail.description,
    url: detail.url,
    transitions: detail.transitions,
    images: detail.images,
    before,
    transitionId: null,
    screenshots: true,
  };
}

export function promptFromTicket(ticket: Pick<LinkedTicket, 'ref' | 'summary' | 'description'>) {
  const head = `[${ticket.ref.key}] ${ticket.summary}`.trim();
  const body = ticket.description.trim();
  const text = body ? `${head}\n\n${body}` : head;
  return [...text].slice(0, MAX_PROMPT).join('');
}

export function pageUrl(location: Pick<Location, 'href'>): string {
  const url = new URL(location.href);
  url.searchParams.delete(TICKET_PARAM);
  return url.toString();
}

export function pageKey(location: Pick<Location, 'href'>): string {
  const url = new URL(pageUrl(location));
  if (!url.hash.startsWith('#/')) url.hash = '';
  return url.toString();
}

export function takeTicketParam(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'replaceState' | 'state'>,
): string | null {
  const url = new URL(location.href);
  const key = url.searchParams.get(TICKET_PARAM);
  if (key === null) return null;
  url.searchParams.delete(TICKET_PARAM);
  history.replaceState(history.state, '', url.toString());
  const upper = key.trim().toUpperCase();
  return TICKET_KEY.test(upper) ? upper : null;
}

export function fileOfImage(image: TicketImage): File {
  const binary = atob(image.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], image.name || 'ticket-image', { type: image.mediaType });
}

export function storedTicket(ticket: LinkedTicket | null): LinkedTicket | null {
  return ticket ? { ...ticket, images: [], before: [] } : null;
}
