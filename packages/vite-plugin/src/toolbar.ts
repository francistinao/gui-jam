import type { GuijamMessage } from '@guijam/contracts-ts';
import type { Tool, Widget, WidgetHost, WidgetModule } from '@guijam/overlay/host';
import { LOGO_DATA_URL } from './logo.js';

type HotContext = NonNullable<ImportMeta['hot']>;

const WIDGET_URL = '/@guijam/widget.js';
const REQUEST_TIMEOUT_MS = 20_000;
const GENERATION_TIMEOUT_MS = 95_000;

const TOOLS: readonly { tool: Tool; label: string; icon: string }[] = [
  {
    tool: 'select',
    label: 'Select',
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 3l14 7-6.2 1.8L10.9 18z" fill="currentColor"/></svg>',
  },
  {
    tool: 'draw',
    label: 'Draw',
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  },
];

const TOOLBAR_CSS = `
:host { all: initial; }
.toolbar {
  position: fixed; right: 20px; bottom: 20px; display: flex; align-items: center; gap: 4px;
  padding: 6px; border-radius: 12px; background: #1e1e1e;
  box-shadow: 0 2px 5px #00000026, 0 10px 24px #0000002e, 0 0 0.5px #00000014;
  font: 12px/1 Inter, system-ui, sans-serif;
}
.logo { width: 32px; height: 32px; border-radius: 8px; background: #fafafa; padding: 3px; box-sizing: border-box; }
.tool {
  width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; color: #fff; cursor: pointer;
}
.tool:hover { background: #383838; }
.tool[aria-pressed="true"] { background: #0d99ff; }
.tool:focus-visible { outline: 2px solid #0d99ff; outline-offset: 2px; }
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
  const buttons = TOOLS.map(({ tool, label, icon }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = icon;
    return { tool, button };
  });
  toolbar.append(logo, ...buttons.map(({ button }) => button));
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
    for (const { tool: own, button } of buttons) {
      button.setAttribute('aria-pressed', String(own === tool));
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
    if (event.altKey && event.shiftKey && event.code === 'KeyM')
      hostElement.hidden = !hostElement.hidden;
  });
}
