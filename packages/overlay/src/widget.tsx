import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createController, initialState, type WidgetState } from './controller';
import { createDrawLayer } from './draw-layer';
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
  const layer = document.createElement('div');
  layer.className = 'guijam-layer';
  // React clears its root on mount, so the draw canvas sits beside the root, not in it.
  const container = document.createElement('div');
  layer.append(container);
  host.shadowRoot.append(layer);

  const store = createStore<WidgetState>(initialState);
  const controller = createController(host, store);
  const selectLayer = createSelectLayer({
    hostElement: host.hostElement,
    onHover: controller.hover,
    onPick: (element) => void controller.select(element),
  });

  const drawLayer = createDrawLayer({
    parent: layer,
    onStroke: (stroke) => {
      void controller.draw(stroke).then((found) => {
        if (!found) drawLayer.clear();
      });
    },
  });
  // The stroke stays on screen while its prompt is open, and goes when it closes.
  let selected = false;
  store.subscribe(() => {
    const now = store.get().selection !== null;
    if (selected && !now) drawLayer.clear();
    selected = now;
  });

  function setTool(tool: WidgetState['tool']): void {
    store.set({ tool });
    if (tool === 'select') selectLayer.enable();
    else selectLayer.disable();
    if (tool === 'draw') drawLayer.enable();
    else drawLayer.disable();
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
