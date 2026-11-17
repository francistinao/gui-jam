import type { GuijamMessage } from '@guijam/contracts-ts';
import type { Tool, Widget, WidgetHost, WidgetModule } from '@guijam/overlay/host';
import { createElement, type IconNode, MousePointer, Pencil } from 'lucide';
import { LOGO_DATA_URL } from './logo.js';

type HotContext = NonNullable<ImportMeta['hot']>;

const WIDGET_URL = '/@guijam/widget.js';
const REQUEST_TIMEOUT_MS = 20_000;
const GENERATION_TIMEOUT_MS = 365_000;

export interface ToolSpec {
  tool: Tool;
  label: string;
  icon: IconNode;
}

export const TOOLS: readonly ToolSpec[] = [
  { tool: 'select', label: 'Select object', icon: MousePointer },
  { tool: 'draw', label: 'Draw', icon: Pencil },
];

export const EXIT_HINT = 'Press Esc to exit';

export function tooltipFor(spec: ToolSpec, active: Tool | null): string {
  return active === spec.tool ? EXIT_HINT : spec.label;
}

const TOOLBAR_CSS = `
:host { all: initial; }
.toolbar {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  display: flex; align-items: center; gap: 4px;
  padding: 6px; border-radius: 12px; background: #1e1e1e;
  box-shadow: 0 2px 5px #00000026, 0 10px 24px #0000002e, 0 0 0.5px #00000014;
  font: 12px/1 Inter, system-ui, sans-serif;
}
.logo { width: 32px; height: 32px; border-radius: 8px; background: #fafafa; padding: 3px; box-sizing: border-box; }
.slot { position: relative; display: grid; }
.tool {
  width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; color: #fff; cursor: pointer; padding: 0;
}
.tool:hover { background: #383838; }
.tool[aria-pressed="true"] { background: #0d99ff; }
.tool:focus-visible { outline: 2px solid #0d99ff; outline-offset: 2px; }
.tool svg { width: 18px; height: 18px; }
.tool .key {
  display: none; padding: 1px 4px; border-radius: 4px; border: 1px solid #ffffffb3;
  font: 600 10px/1.2 Inter, system-ui, sans-serif; letter-spacing: 0.02em;
}
.tool[aria-pressed="true"] .icon { display: none; }
.tool[aria-pressed="true"] .key { display: block; }
.tip {
  position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%);
  white-space: nowrap; padding: 5px 8px; border-radius: 6px; background: #1e1e1e; color: #fff;
  font: 500 11px/1.2 Inter, system-ui, sans-serif; box-shadow: 0 2px 8px #00000040;
  visibility: hidden; opacity: 0; transition: opacity 120ms ease; pointer-events: none;
}
.slot:hover .tip, .tool:focus-visible + .tip { visibility: visible; opacity: 1; }
`;

function isWidgetModule(value: unknown): value is WidgetModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { mount?: unknown }).mount === 'function'
  );
}

function timeoutFor(type: string): number {
  return type === 'generate.request' ? GENERATION_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

function createRequester(hot: HotContext): WidgetHost['request'] {
  let next = 1;
  const waiting = new Map<string, (reply: GuijamMessage) => void>();
  hot.on('gj:response', (reply) => {
    const resolve = reply.id === undefined ? undefined : waiting.get(reply.id);
    if (resolve && reply.id !== undefined) {
      waiting.delete(reply.id);
      resolve(reply);
    }
  });
  return (message) =>
    new Promise((resolve) => {
      const id = `w${next++}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({
          type: 'error',
          id,
          payload: {
            code: 'DAEMON_UNAVAILABLE',
            message: 'The dev server did not answer.',
            action: 'Check the dev server terminal, then retry.',
          },
        });
      }, timeoutFor(message.type));
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      hot.send('gj:request', { ...message, id });
    });
}

export function bootToolbar(hot: HotContext): void {
  const hostElement = document.createElement('div');
  hostElement.id = 'guijam-root';
  document.documentElement.append(hostElement);
  const shadowRoot = hostElement.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(TOOLBAR_CSS);
  shadowRoot.adoptedStyleSheets = [sheet];

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'GUIJam');
  const logo = document.createElement('img');
  logo.className = 'logo';
  logo.src = LOGO_DATA_URL;
  logo.alt = 'GUIJam';
  const buttons = TOOLS.map((spec) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.setAttribute('aria-label', spec.label);
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.append(createElement(spec.icon, { 'aria-hidden': 'true' }));
    const key = document.createElement('span');
    key.className = 'key';
    key.setAttribute('aria-hidden', 'true');
    key.textContent = 'Esc';
    button.append(icon, key);
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.id = `guijam-tip-${spec.tool}`;
    tip.setAttribute('role', 'tooltip');
    tip.textContent = tooltipFor(spec, null);
    button.setAttribute('aria-describedby', tip.id);
    slot.append(button, tip);
    return { spec, tool: spec.tool, button, tip, slot };
  });
  toolbar.append(logo, ...buttons.map(({ slot }) => slot));
  shadowRoot.append(toolbar);

  const request = createRequester(hot);
  const listeners = new Set<(message: GuijamMessage) => void>();
  hot.on('gj:event', (message) => {
    for (const listener of listeners) listener(message);
  });
  const onEvent: WidgetHost['onEvent'] = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let active: Tool | null = null;
  let widget: Promise<Widget> | undefined;

  const show = (tool: Tool | null) => {
    active = tool;
    for (const { spec, button, tip } of buttons) {
      const pressed = spec.tool === tool;
      button.setAttribute('aria-pressed', String(pressed));
      if (pressed) button.setAttribute('aria-keyshortcuts', 'Escape');
      else button.removeAttribute('aria-keyshortcuts');
      tip.textContent = tooltipFor(spec, tool);
    }
  };

  const loadWidget = (): Promise<Widget> => {
    widget ??= import(/* @vite-ignore */ WIDGET_URL).then((module: unknown) => {
      if (!isWidgetModule(module)) throw new Error(`${WIDGET_URL} is not the GUIJam widget`);
      return module.mount({ shadowRoot, hostElement, request, onEvent, onToolChange: show });
    });
    return widget;
  };

  for (const { tool, button } of buttons) {
    button.addEventListener('click', () => {
      const next = active === tool ? null : tool;
      loadWidget().then(
        (loaded) => {
          loaded.setTool(next);
          show(next);
        },
        (error: unknown) => {
          widget = undefined;
          console.error('[guijam] the widget failed to load', error);
        },
      );
    });
  }

  document.addEventListener('keydown', (event) => {
    if (!(event.altKey && event.shiftKey && event.code === 'KeyM')) return;
    hostElement.hidden = !hostElement.hidden;
    if (!hostElement.hidden || active === null || !widget) return;
    void widget.then((loaded) => {
      loaded.setTool(null);
      show(null);
    });
  });
}
