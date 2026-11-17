import type { GuijamMessage } from '@guijam/contracts-ts';
import { bootToolbar, type ToolbarChannel } from './toolbar.js';

declare const process: { env: { GUIJAM_RELAY_URL?: string; GUIJAM_WIDGET_URL?: string } };

type Listener = (data: GuijamMessage) => void;

const BOOTED: unique symbol = Symbol.for('guijam.client.booted');
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 5_000;

function connect(url: string): ToolbarChannel {
  const listeners = new Map<string, Set<Listener>>();
  const queue: string[] = [];
  let socket: WebSocket | undefined;
  let delay = RETRY_MIN_MS;
  const open = () => {
    const next = new WebSocket(url);
    socket = next;
    next.addEventListener('open', () => {
      delay = RETRY_MIN_MS;
      for (const text of queue.splice(0)) next.send(text);
    });
    next.addEventListener('message', (event) => {
      const { event: name, data } = JSON.parse(String(event.data)) as {
        event?: string;
        data?: GuijamMessage;
      };
      if (name === undefined || data === undefined) return;
      for (const listener of listeners.get(name) ?? []) listener(data);
    });
    next.addEventListener('close', () => {
      socket = undefined;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    });
  };
  open();
  return {
    send(event, data) {
      const text = JSON.stringify({ event, data });
      if (socket?.readyState === WebSocket.OPEN) socket.send(text);
      else queue.push(text);
    },
    on(event, listener) {
      const known = listeners.get(event) ?? new Set<Listener>();
      known.add(listener);
      listeners.set(event, known);
    },
  };
}

const scope = globalThis as typeof globalThis & { [BOOTED]?: true };
const url = process.env.GUIJAM_RELAY_URL;
const widgetUrl = process.env.GUIJAM_WIDGET_URL;

if (typeof window !== 'undefined' && !scope[BOOTED] && url && widgetUrl) {
  scope[BOOTED] = true;
  const channel = connect(url);
  const boot = () => bootToolbar(channel, widgetUrl);
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
}
