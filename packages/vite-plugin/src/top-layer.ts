import type { Listen } from './shield.js';

const RESETS: Readonly<Record<string, string>> = {
  inset: '0 auto auto 0',
  width: '0',
  height: '0',
  margin: '0',
  padding: '0',
  border: '0',
  background: 'none',
  overflow: 'visible',
};

interface Movable {
  moveBefore?(node: Node, child: Node | null): void;
}

function layered(element: Element, host: HTMLElement): boolean {
  if (element === host || !(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element instanceof HTMLDialogElement) return element.matches(':modal');
  return (
    (element.popover === 'auto' || element.popover === 'hint') && element.matches(':popover-open')
  );
}

function move(host: HTMLElement, parent: Element & Movable): void {
  if (parent.moveBefore && host.isConnected) parent.moveBefore(host, null);
  else parent.append(host);
}

export function followTopLayer(host: HTMLElement, listen: Listen): void {
  if (typeof host.showPopover !== 'function') return;
  host.popover = 'manual';
  for (const [name, value] of Object.entries(RESETS))
    host.style.setProperty(name, value, 'important');
  const backdrop = document.createElement('style');
  backdrop.textContent = `#${host.id}::backdrop { display: none !important; }`;
  document.head.append(backdrop);

  const open: Element[] = [];

  function show(): void {
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  }

  const removals = new MutationObserver(() => settle(false));

  function settle(raise: boolean): void {
    for (let index = open.length - 1; index >= 0; index -= 1) {
      const element = open[index];
      if (element && !layered(element, host)) open.splice(index, 1);
    }
    const parent = open.at(-1) ?? document.documentElement;
    const moving = host.parentNode !== parent;
    if (!moving && !raise && host.matches(':popover-open')) return;
    const focused = document.activeElement === host ? host.shadowRoot?.activeElement : null;
    if (moving) move(host, parent);
    show();
    if (focused instanceof HTMLElement && host.shadowRoot?.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
    removals.disconnect();
    if (parent !== document.documentElement) {
      removals.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function track(element: Element): void {
    if (element === host) return;
    const index = open.indexOf(element);
    const now = layered(element, host);
    if (index >= 0 && !now) open.splice(index, 1);
    if (index < 0 && now) open.push(element);
    settle(index < 0 && now);
  }

  listen(
    document,
    'toggle',
    (event) => {
      if (event.target === host) {
        if (!host.matches(':popover-open')) show();
      } else if (event.target instanceof Element) {
        track(event.target);
      }
    },
    true,
  );
  listen(
    document,
    'close',
    (event) => {
      if (event.target instanceof Element) track(event.target);
    },
    true,
  );
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof HTMLDialogElement) track(record.target);
    }
  }).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });

  for (const element of document.querySelectorAll('dialog, [popover]')) {
    if (layered(element, host)) open.push(element);
  }
  settle(true);
}
