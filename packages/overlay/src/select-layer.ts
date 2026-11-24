import type { WidgetHost } from './host';

const SRC_SELECTOR = '[data-gj-src]';
const SWALLOWED = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'] as const;

interface SelectLayerOptions {
  hostElement: HTMLElement;
  intercept: WidgetHost['intercept'];
  onHover(element: Element | null): void;
  onPick(element: Element, additive: boolean): void;
}

export function createSelectLayer({ hostElement, intercept, onHover, onPick }: SelectLayerOptions) {
  const fromWidget = (event: Event) => event.composedPath().includes(hostElement);
  const annotated = (event: Event) =>
    event.target instanceof Element ? event.target.closest(SRC_SELECTOR) : null;
  let enabled = false;

  intercept('pointermove', (event) => {
    if (enabled && !fromWidget(event)) onHover(annotated(event));
  });

  function swallow(event: Event): void {
    if (!enabled || fromWidget(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!(event instanceof MouseEvent) || event.type !== 'click') return;
    const element = annotated(event);
    if (element) onPick(element, event.shiftKey);
  }
  for (const type of SWALLOWED) intercept(type, swallow);

  return {
    enable(): void {
      enabled = true;
    },
    disable(): void {
      if (!enabled) return;
      enabled = false;
      onHover(null);
    },
  };
}
