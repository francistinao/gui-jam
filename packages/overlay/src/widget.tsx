import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createController, HISTORY_KEY, initialState, type WidgetState } from './controller';
import { createDrawLayer } from './draw-layer';
import type { Widget, WidgetHost } from './host';
import {
  activeLayers,
  closesOnEscape,
  isCopyShortcut,
  type Layers,
  sketchingOver,
  strokeShortcut,
} from './model';
import { load, loadSections, loadStyle, save, saveSections, saveStyle } from './persist';
import { createSelectLayer } from './select-layer';
import { createStore } from './store';
import css from './styles.css?inline';
import { takeTicketParam } from './tracker';

export type { Widget, WidgetHost, WidgetModule } from './host';

const PROPERTY_RULE = /@property\s+[^{]+\{[^}]*\}/g;
const HOVER = [
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'pointermove',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'mousemove',
] as const;

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

function takeHistoryFlag(): boolean {
  try {
    const flagged = sessionStorage.getItem(HISTORY_KEY) !== null;
    sessionStorage.removeItem(HISTORY_KEY);
    return flagged;
  } catch {
    return false;
  }
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

  const store = createStore<WidgetState>({ ...initialState, openSections: loadSections() });
  const controller = createController(host, store);
  const selectLayer = createSelectLayer({
    hostElement: host.hostElement,
    intercept: host.intercept,
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
    drawLayer.keepOnly(
      store
        .get()
        .jobs.filter((job) => !job.sketchHidden)
        .flatMap((job) => job.strokes),
    );
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

  function leaveOnEscape(): boolean {
    const { selection, tool, pasting } = store.get();
    if (pasting) {
      controller.stopPasting();
      return true;
    }
    if (selection) {
      void controller.close();
      return true;
    }
    if (!tool) return false;
    setTool(null);
    host.onToolChange(null);
    return true;
  }

  const inside = (event: Event) => event.composedPath().includes(host.hostElement);

  host.intercept('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || !closesOnEscape(event)) return;
    if (inside(event)) {
      event.preventDefault();
    } else if (leaveOnEscape()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  const holding = () => {
    const { selection, focus } = store.get();
    return selection !== null || focus !== null;
  };
  for (const type of HOVER) {
    host.intercept(type, (event) => {
      const dragging = event instanceof MouseEvent && event.buttons !== 0;
      if (holding() && !dragging && !inside(event)) event.stopImmediatePropagation();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (isCopyShortcut(event) && !typing(event)) {
      if (controller.copyStyle()) event.preventDefault();
      return;
    }
    const shortcut = strokeShortcut(event);
    if (shortcut) {
      if (typing(event)) return;
      const done = shortcut === 'undo' ? controller.undoSketch() : controller.redoSketch();
      if (done) event.preventDefault();
      return;
    }
    if (!closesOnEscape(event)) return;
    const inPicker = event
      .composedPath()
      .some((node) => node instanceof HTMLElement && node.hasAttribute('data-color-picker'));
    if (!inPicker) leaveOnEscape();
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

  let copied = { copied: store.get().copied, pasting: store.get().pasting };
  store.subscribe(() => {
    const { copied: style, pasting } = store.get();
    if (style === copied.copied && pasting === copied.pasting) return;
    copied = { copied: style, pasting };
    saveStyle(style && pasting ? { copied: style, pasting } : null);
  });

  let sections = store.get().openSections;
  store.subscribe(() => {
    const { openSections } = store.get();
    if (openSections === sections) return;
    sections = openSections;
    saveSections(openSections);
  });

  createRoot(container).render(<App store={store} controller={controller} />);
  const style = loadStyle();
  if (style) controller.restoreStyle(style.copied, style.pasting);
  if (takeHistoryFlag()) controller.openHistory();
  const restored = load();
  if (restored) void controller.restore(restored).then(repaint);
  const linked = takeTicketParam(window.location, window.history);
  void controller.loadTracker().then(() => {
    if (linked) controller.openTicketLink(linked);
  });
  return { setTool };
}
