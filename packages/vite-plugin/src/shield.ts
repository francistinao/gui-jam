import { guardListeners, ownCode } from './listener-guard.js';

type Listener = EventListenerOrEventListenerObject;
type Options = boolean | AddEventListenerOptions | undefined;

export type Interceptor = (event: Event) => void;

export type Listen = (
  target: EventTarget,
  type: string,
  listener: Listener,
  options?: Options,
) => () => void;

export interface Shield {
  protect(host: HTMLElement, ownUrls: readonly string[]): void;
  intercept(type: string, handler: Interceptor): () => void;
  listen: Listen;
}

const INTERCEPTED = [
  'keydown',
  'pointerdown',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointermove',
  'mousemove',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'focusout',
  'blur',
] as const;

const LEAVING = ['focusout', 'blur', 'pointerout', 'pointerleave', 'mouseout', 'mouseleave'];

const CONTROL_KEYS = new Set([
  'Escape',
  'Enter',
  ' ',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function typingIn(event: Event): boolean {
  const [target] = event.composedPath();
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

function reachesPage(event: Event): boolean {
  return event instanceof KeyboardEvent && !CONTROL_KEYS.has(event.key) && !typingIn(event);
}

export function installShield(): Shield {
  let host: HTMLElement | null = null;
  let urls: readonly string[] = [];
  const pageRoot = (target: EventTarget) =>
    target === window || target === document || target === document.documentElement;

  const { add, remove } = guardListeners(EventTarget.prototype, {
    wraps(target) {
      if (pageRoot(target)) return !ownCode(new Error().stack, urls);
      if (!(target instanceof Node) || target === host) return false;
      return host === null || target.getRootNode() !== host.shadowRoot;
    },
    skips(event, target) {
      if (host === null) return false;
      if (!pageRoot(target) && host.parentNode === document.documentElement) return false;
      return event.composedPath().includes(host) && !reachesPage(event);
    },
  });

  const handlers = new Map<string, Interceptor[]>();
  function queue(type: string): Interceptor[] {
    const known = handlers.get(type);
    if (known) return known;
    const list: Interceptor[] = [];
    handlers.set(type, list);
    add.call(
      window,
      type,
      (event: Event) => {
        for (const handler of [...list]) {
          handler(event);
          if (event.cancelBubble) return;
        }
      },
      true,
    );
    return list;
  }
  for (const type of INTERCEPTED) queue(type);

  const intercept = (type: string, handler: Interceptor) => {
    const list = queue(type);
    list.push(handler);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };

  const leaving = (event: Event) => {
    const related = (event as FocusEvent).relatedTarget;
    if (host === null || !(related instanceof Node) || !host.contains(related)) return;
    if (event.composedPath().includes(host)) return;
    event.stopImmediatePropagation();
  };
  for (const type of LEAVING) intercept(type, leaving);

  const listen: Listen = (target, type, listener, options) => {
    add.call(target, type, listener, options);
    return () => remove.call(target, type, listener, options);
  };

  return {
    protect(element, ownUrls) {
      host = element;
      urls = ownUrls;
      element.setAttribute('data-no-focus-lock', '');
    },
    intercept,
    listen,
  };
}
