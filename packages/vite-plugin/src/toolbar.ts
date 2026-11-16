import type { GuijamMessage } from '@guijam/contracts-ts';
import type { Tool, Widget, WidgetHost, WidgetModule } from '@guijam/overlay/host';
import { LOGO_DATA_URL } from './logo.js';

type HotContext = NonNullable<ImportMeta['hot']>;

const WIDGET_URL = '/@guijam/widget.js';
const REQUEST_TIMEOUT_MS = 20_000;

const SELECT_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 3l14 7-6.2 1.8L10.9 18z" fill="currentColor"/></svg>';

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
      }, REQUEST_TIMEOUT_MS);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      hot.send('gj:request', { ...message, id });
    });
}

/**
 * The always-visible toolbar is plain DOM; the React widget behind it is fetched the
 * first time a tool is chosen, so pages pay almost nothing until GUIJam is used.
 */
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
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'tool';
  select.setAttribute('aria-label', 'Select');
  select.setAttribute('aria-pressed', 'false');
  select.innerHTML = SELECT_ICON;
  toolbar.append(logo, select);
  shadowRoot.append(toolbar);

  const request = createRequester(hot);
  let active: Tool | null = null;
  let widget: Promise<Widget> | undefined;

  const show = (tool: Tool | null) => {
    active = tool;
    select.setAttribute('aria-pressed', String(tool === 'select'));
  };

  const loadWidget = (): Promise<Widget> => {
    widget ??= import(/* @vite-ignore */ WIDGET_URL).then((module: unknown) => {
      if (!isWidgetModule(module)) throw new Error(`${WIDGET_URL} is not the GUIJam widget`);
      return module.mount({ shadowRoot, hostElement, request, onToolChange: show });
    });
    return widget;
  };

  // The button only shows a tool as active once the widget is listening for it.
  select.addEventListener('click', () => {
    const next = active === 'select' ? null : 'select';
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

  document.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyM')
      hostElement.hidden = !hostElement.hidden;
  });
}
