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
    onStroke: (points, bounds) => {
      void controller.draw(points, bounds).then(repaint);
    },
  });
  function repaint(): void {
    drawLayer.keepOnly(store.get().jobs.flatMap((job) => job.strokes));
  }
  let painted = store.get().jobs;
  store.subscribe(() => {
    const { jobs } = store.get();
    if (jobs === painted) return;
    painted = jobs;
    repaint();
  });

  function setTool(tool: WidgetState['tool']): void {
    store.set({ tool });
    if (tool === 'select') selectLayer.enable();
    else selectLayer.disable();
    if (tool === 'draw') {
      drawLayer.enable();
      repaint();
    } else {
      drawLayer.disable();
    }
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
