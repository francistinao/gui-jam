import type { CodeChange } from '@guijam/contracts-ts';
import { Move, X } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Controller, Selection } from './controller';
import { Button } from './figui/button';
import { cn } from './figui/cn';
import {
  nudgePanel,
  type PanelSpot,
  type Point,
  pastDragThreshold,
  placeHeldPanel,
  placePopover,
  type Rect,
  type Size,
} from './model';

const POPOVER_WIDTH = 300;
const HANDS_OFF = 'button, a, input, textarea, select, [contenteditable]';

export const SKETCH_LABEL = 'Sketch what you want for this component';

let viewport: Size = { width: 0, height: 0 };

function readViewport(): Size {
  if (viewport.width !== window.innerWidth || viewport.height !== window.innerHeight) {
    viewport = { width: window.innerWidth, height: window.innerHeight };
  }
  return viewport;
}

function onResize(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

function handsOff(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(HANDS_OFF) !== null;
}

interface Grab {
  pointerId: number;
  from: Point;
  origin: PanelSpot;
  moved: boolean;
}

interface PanelMover {
  dragging: boolean;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onPointerMove(event: PointerEvent<HTMLElement>): void;
  onPointerUp(event: PointerEvent<HTMLElement>): void;
  onPointerCancel(event: PointerEvent<HTMLElement>): void;
  reset(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
}

const MoverContext = createContext<PanelMover | null>(null);

interface PopoverProps {
  label: string;
  anchor: Rect;
  at: PanelSpot | null;
  onMove(spot: PanelSpot | null): void;
  children: ReactNode;
}

export function Popover({ label, anchor, at, onMove, children }: PopoverProps) {
  const [height, setHeight] = useState(360);
  const [held, setHeld] = useState<PanelSpot | null>(null);
  const grab = useRef<Grab | null>(null);
  const reset = useCallback(() => onMove(null), [onMove]);
  const screen = useSyncExternalStore(onResize, readViewport);
  const [toolbar, setToolbar] = useState<Element | null>(null);
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const root = element.getRootNode();
    if (root instanceof ShadowRoot || root instanceof Document) {
      setToolbar(root.querySelector('[role="toolbar"]'));
    }
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const size = { width: POPOVER_WIDTH, height };
  const spot = held ?? at;
  const placed = spot ? placeHeldPanel(spot, size, screen) : null;
  const avoid = toolbar?.getBoundingClientRect() ?? null;
  const placement = placed ?? placePopover(anchor, size, screen, 12, avoid);

  const dropAt = (event: PointerEvent<HTMLElement>, started: Grab): PanelSpot => ({
    left: started.origin.left + event.clientX - started.from.x,
    top: started.origin.top + event.clientY - started.from.y,
  });

  const mover: PanelMover = {
    dragging: held !== null,
    onPointerDown(event) {
      if (event.button !== 0 || !event.isPrimary || handsOff(event.target)) return;
      grab.current = {
        pointerId: event.pointerId,
        from: { x: event.clientX, y: event.clientY },
        origin: { left: placement.left, top: placement.top },
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event) {
      const started = grab.current;
      if (!started || started.pointerId !== event.pointerId) return;
      if (
        !started.moved &&
        !pastDragThreshold(started.from, { x: event.clientX, y: event.clientY })
      )
        return;
      started.moved = true;
      setHeld(dropAt(event, started));
    },
    onPointerUp(event) {
      const started = grab.current;
      if (!started || started.pointerId !== event.pointerId) return;
      grab.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!started.moved) return;
      const dropped = placeHeldPanel(dropAt(event, started), size, screen);
      onMove({ left: dropped.left, top: dropped.top });
      setHeld(null);
    },
    onPointerCancel() {
      grab.current = null;
      setHeld(null);
    },
    reset,
    onKeyDown(event) {
      if (event.target !== event.currentTarget) return;
      const next = nudgePanel(placement, event.key, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      if (next === 'reset') {
        reset();
        return;
      }
      const moved = placeHeldPanel(next, size, screen);
      onMove({ left: moved.left, top: moved.top });
    },
  };

  return (
    <div
      ref={measure}
      role="dialog"
      aria-label={label}
      data-interactive=""
      data-moved={spot ? '' : undefined}
      className={cn(
        'fixed flex flex-col overflow-y-auto rounded-[13px] bg-white-1000 p-3 text-black-800 shadow-500 ring-1 ring-black-100',
        placed ? null : 'max-h-[calc(100vh-24px)]',
      )}
      style={{
        left: placement.left,
        top: placement.top,
        width: POPOVER_WIDTH,
        maxHeight: placed?.maxHeight,
      }}
    >
      <MoverContext value={mover}>{children}</MoverContext>
    </div>
  );
}

interface PopoverHeaderProps {
  tag: string | undefined;
  badge?: string;
  number?: number;
  selection?: Selection;
  subtitle?: string;
  onClose?: () => void;
  controller: Controller;
  children?: ReactNode;
}

export function PopoverHeader({
  tag,
  badge,
  number,
  selection,
  subtitle,
  onClose,
  controller,
  children,
}: PopoverHeaderProps) {
  const mover = useContext(MoverContext);
  const reset = mover?.reset;
  const resetOnDoubleClick = useCallback(
    (header: HTMLElement | null) => {
      if (!header || !reset) return;
      const listener = (event: Event) => {
        if (!handsOff(event.target)) reset();
      };
      header.addEventListener('dblclick', listener);
      return () => header.removeEventListener('dblclick', listener);
    },
    [reset],
  );
  return (
    <header
      ref={resetOnDoubleClick}
      data-dragging={mover?.dragging ? '' : undefined}
      onPointerDown={mover?.onPointerDown}
      onPointerMove={mover?.onPointerMove}
      onPointerUp={mover?.onPointerUp}
      onPointerCancel={mover?.onPointerCancel}
      className={cn(
        'flex cursor-grab touch-none items-start justify-between gap-2 pb-2 select-none',
        mover?.dragging ? 'cursor-grabbing' : null,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {number === undefined ? null : (
            <span
              role="img"
              aria-label={`Drawing ${number}`}
              className="typography-body-small flex size-5 items-center justify-center rounded-full bg-blue-500 font-[600] text-white-1000"
            >
              {number}
            </span>
          )}
          <span className="typography-body-medium font-[600]">{tag ?? '…'}</span>
          {badge ? (
            <span className="typography-body-small rounded-sm bg-green-100 px-1 text-green-700">
              {badge}
            </span>
          ) : null}
        </div>
        <code className="typography-body-small block truncate text-grey-500">
          {subtitle ?? (selection ? `${selection.file}:${selection.line}` : '')}
        </code>
      </div>
      <div className="flex items-center gap-1">
        {mover ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Move panel"
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home"
            className="sr-only focus-visible:not-sr-only"
            onKeyDown={mover.onKeyDown}
          >
            <Move aria-hidden="true" />
          </Button>
        ) : null}
        {children}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={onClose ?? (() => void controller.close())}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}

function numbered(first: number, sign: string, lines: readonly string[]): string {
  return lines.map((line, index) => `${first + index} ${sign} ${line.trim()}`).join('\n');
}

export function CodeChanges({ changes }: { changes: readonly CodeChange[] }) {
  if (changes.length === 0) {
    return <p className="typography-body-medium py-3 text-grey-500">No changes yet.</p>;
  }
  const multiFile = new Set(changes.map((change) => change.file)).size > 1;
  return (
    <section
      aria-label="Code changes"
      className="my-2 flex max-h-40 flex-col gap-2 overflow-y-auto overscroll-contain"
    >
      {changes.map((change) => (
        <pre
          key={`${change.file}:${change.line}`}
          className="typography-body-small rounded-md bg-grey-100 p-2 font-mono break-all whitespace-pre-wrap"
        >
          {multiFile ? (
            <span data-change-file="" className="block text-grey-500">
              {change.file}
            </span>
          ) : null}
          {change.before.length > 0 ? (
            <span className="block text-red-600">{numbered(change.line, '-', change.before)}</span>
          ) : null}
          {change.after.length > 0 ? (
            <span className="block text-green-600">{numbered(change.line, '+', change.after)}</span>
          ) : null}
        </pre>
      ))}
    </section>
  );
}

export function RunNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul
      aria-label="Notes"
      className="typography-body-small m-0 flex list-none flex-col gap-1 rounded-md bg-yellow-100 p-2 text-grey-800"
    >
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
