import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createController, initialState, type WidgetState } from './controller';
import { createDrawLayer } from './draw-layer';
import type { Widget, WidgetHost } from './host';
import { activeLayers, type Layers, sketchingOver, strokeShortcut } from './model';
import { load, save } from './persist';
import { createSelectLayer } from './select-layer';
import { createStore } from './store';
import css from './styles.css?inline';
import { takeTicketParam } from './tracker';

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

function typing(event: Event): boolean {
  const [target] = event.composedPath();
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
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
    onPick: (element, additive) => void controller.select(element, additive),
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

  let layers: Layers = { select: false, draw: false };
  function syncLayers(): void {
    const { tool, mode, jobs, focus } = store.get();
    const next = activeLayers(
      tool,
      sketchingOver(
        mode,
        jobs.find((job) => job.id === focus),
      ),
    );
    const previous = layers;
    layers = next;
    if (next.select !== previous.select) {
      if (next.select) selectLayer.enable();
      else selectLayer.disable();
    }
    if (next.draw !== previous.draw) {
      if (next.draw) {
        drawLayer.enable();
        repaint();
      } else {
        drawLayer.disable();
      }
    }
  }
  store.subscribe(syncLayers);

  function setTool(tool: WidgetState['tool']): void {
    store.set({ tool });
  }

  document.addEventListener('keydown', (event) => {
    const shortcut = strokeShortcut(event);
    if (shortcut) {
      if (typing(event)) return;
      const done = shortcut === 'undo' ? controller.undoSketch() : controller.redoSketch();
      if (done) event.preventDefault();
      return;
    }
    if (event.key !== 'Escape') return;
    const inPicker = event
      .composedPath()
      .some((node) => node instanceof HTMLElement && node.hasAttribute('data-color-picker'));
    if (inPicker) return;
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

  let saved = { jobs: store.get().jobs, focus: store.get().focus };
  store.subscribe(() => {
    const { jobs, focus } = store.get();
    if (jobs === saved.jobs && focus === saved.focus) return;
    saved = { jobs, focus };
    save(jobs, focus);
  });

  createRoot(container).render(<App store={store} controller={controller} />);
  const restored = load();
  if (restored) void controller.restore(restored).then(repaint);
  const linked = takeTicketParam(window.location, window.history);
  void controller.loadTracker().then(() => {
    if (linked) controller.openTicketLink(linked);
  });
  return { setTool };
}
