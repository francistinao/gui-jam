import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createController, initialState, type WidgetState } from './controller';
import type { Widget, WidgetHost } from './host';
import { createSelectLayer } from './select-layer';
import { createStore } from './store';
import css from './styles.css?inline';

export type { Widget, WidgetHost, WidgetModule } from './host';

const PROPERTY_RULE = /@property\s+[^{]+\{[^}]*\}/g;

// Registered @property rules are ignored inside a shadow root, so they are the one
// thing the widget adds to the page's document (FR-023). They only name --tw-* properties.
function adoptStyles(shadowRoot: ShadowRoot): void {
  const properties = css.match(PROPERTY_RULE) ?? [];
  if (properties.length > 0 && !document.querySelector('style[data-guijam-properties]')) {
    const style = document.createElement('style');
    style.dataset.guijamProperties = '';
    style.textContent = properties.join('\n');
    document.head.append(style);
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css.replace(PROPERTY_RULE, ''));
  shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
}

export function mount(host: WidgetHost): Widget {
  adoptStyles(host.shadowRoot);
  const container = document.createElement('div');
  container.className = 'guijam-layer';
  host.shadowRoot.append(container);

  const store = createStore<WidgetState>(initialState);
  const controller = createController(host, store);
  const layer = createSelectLayer({
    hostElement: host.hostElement,
    onHover: controller.hover,
    onPick: (element) => void controller.select(element),
  });

  function setTool(tool: WidgetState['tool']): void {
    store.set({ tool });
    if (tool === 'select') layer.enable();
    else layer.disable();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const { selection, tool } = store.get();
    if (selection) {
      void controller.close();
    } else if (tool) {
      setTool(null);
      host.onToolChange(null);
    }
  });
  window.addEventListener('scroll', controller.reanchor, { capture: true, passive: true });
  window.addEventListener('resize', controller.reanchor, { passive: true });

  createRoot(container).render(<App store={store} controller={controller} />);
  return { setTool };
}
