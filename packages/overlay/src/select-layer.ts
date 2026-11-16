const SRC_SELECTOR = '[data-gj-src]';
const SWALLOWED = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'] as const;

interface SelectLayerOptions {
  hostElement: HTMLElement;
  onHover(element: Element | null): void;
  onPick(element: Element): void;
}

export function createSelectLayer({ hostElement, onHover, onPick }: SelectLayerOptions) {
  const fromWidget = (event: Event) => event.composedPath().includes(hostElement);
  const annotated = (event: Event) =>
    event.target instanceof Element ? event.target.closest(SRC_SELECTOR) : null;

  function onPointerMove(event: PointerEvent): void {
    if (!fromWidget(event)) onHover(annotated(event));
  }

  function swallow(event: Event): void {
    if (fromWidget(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    const element = annotated(event);
    if (element) onPick(element);
  }

  let enabled = false;
  return {
    enable(): void {
      if (enabled) return;
      enabled = true;
      document.addEventListener('pointermove', onPointerMove, true);
      for (const type of SWALLOWED) document.addEventListener(type, swallow, true);
    },
    disable(): void {
      if (!enabled) return;
      enabled = false;
      document.removeEventListener('pointermove', onPointerMove, true);
      for (const type of SWALLOWED) document.removeEventListener(type, swallow, true);
      onHover(null);
    },
  };
}
