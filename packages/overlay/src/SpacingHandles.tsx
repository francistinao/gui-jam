import type { ElementStyle } from '@guijam/contracts-ts';
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import type { Controller, WidgetState } from './controller';
import {
  draggedSpacing,
  type GapSlot,
  gapSlots,
  heldSpacing,
  type Point,
  paddingBands,
  panelSections,
  pastDragThreshold,
  type Rect,
  SIDES,
  type Side,
  SPACING_RANGE,
  snapSpacing,
  spacingLabel,
} from './model';
import { useScreen } from './screen';
import { type Store, useStore } from './store';

type Target = Side | 'row' | 'column';

const NAMES: Record<Target, string> = {
  top: 'Padding top',
  right: 'Padding right',
  bottom: 'Padding bottom',
  left: 'Padding left',
  row: 'Row gap',
  column: 'Column gap',
};
const PILL_LONG = 16;
const PILL_SHORT = 4;
const HIT = 10;

interface Grab {
  pointerId: number;
  from: Point;
  start: number;
  moved: boolean;
}

function pillAt(rect: Rect, vertical: boolean): Rect {
  const width = vertical ? PILL_SHORT : PILL_LONG;
  const height = vertical ? PILL_LONG : PILL_SHORT;
  return {
    left: rect.left + rect.width / 2 - width / 2,
    top: rect.top + rect.height / 2 - height / 2,
    width,
    height,
  };
}

function Handle({
  target,
  band,
  value,
  style,
  controller,
}: {
  target: Target;
  band: Rect;
  value: number;
  style: ElementStyle;
  controller: Controller;
}) {
  const grab = useRef<Grab | null>(null);
  const [dragging, setDragging] = useState(false);
  const step = style.theme.spacing || 4;
  const vertical = target === 'left' || target === 'right' || target === 'column';
  const pill = pillAt(band, vertical);
  const label = spacingLabel(value, target, style);
  const set = (next: number, mirror: boolean) => {
    const mirrored = mirror && target !== 'row' && target !== 'column';
    controller.editSpacing(target, next, mirrored);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    grab.current = {
      pointerId: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      start: value,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const started = grab.current;
    if (!started || started.pointerId !== event.pointerId) return;
    const to = { x: event.clientX, y: event.clientY };
    if (!started.moved && !pastDragThreshold(started.from, to)) return;
    if (!started.moved) {
      started.moved = true;
      setDragging(true);
    }
    const delta = { x: to.x - started.from.x, y: to.y - started.from.y };
    set(draggedSpacing(started.start, target, delta, step, event.shiftKey), event.altKey);
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (grab.current?.pointerId !== event.pointerId) return;
    grab.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction =
      event.key === 'ArrowUp' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const amount = event.shiftKey ? 1 : step;
    set(snapSpacing(value + direction * amount, step, event.shiftKey), event.altKey);
  };
  return (
    <>
      <div
        role="slider"
        tabIndex={0}
        data-interactive=""
        data-spacing-handle={target}
        aria-label={NAMES[target]}
        aria-orientation={vertical ? 'horizontal' : 'vertical'}
        aria-valuemin={SPACING_RANGE.min}
        aria-valuemax={SPACING_RANGE.max}
        aria-valuenow={value}
        aria-valuetext={label}
        title={label}
        className={`fixed flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${vertical ? 'cursor-ew-resize' : 'cursor-ns-resize'}`}
        style={{
          left: pill.left - HIT / 2,
          top: pill.top - HIT / 2,
          width: pill.width + HIT,
          height: pill.height + HIT,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={onKeyDown}
      >
        <span
          aria-hidden="true"
          className="rounded-full bg-pink-500 ring-1 ring-white-1000"
          style={{ width: pill.width, height: pill.height }}
        />
      </div>
      {dragging ? (
        <span
          aria-hidden="true"
          className="typography-body-small fixed rounded-sm bg-pink-500 px-1 text-white-1000"
          style={{ left: pill.left + pill.width + 6, top: pill.top - 8 }}
        >
          {label}
        </span>
      ) : null}
    </>
  );
}

export function SpacingHandles({
  store,
  controller,
}: {
  store: Store<WidgetState>;
  controller: Controller;
}) {
  const mode = useStore(store, (state) => state.mode);
  const anchor = useStore(store, (state) => state.anchor);
  const style = useStore(store, (state) => state.style);
  const current = useStore(store, (state) => state.current);
  const draft = useStore(store, (state) => state.draft);
  const gone = useStore(store, (state) => state.selectionGone);
  const src = useStore(store, (state) => state.selection?.src);
  const screen = useScreen();
  useEffect(() => {
    const element = src ? controller.selectedElement() : undefined;
    if (!element) return;
    const observer = new ResizeObserver(() => controller.reanchor());
    observer.observe(element);
    return () => observer.disconnect();
  }, [controller, src]);
  if (mode !== 'finetune' || !anchor || !style || !current || gone) return null;
  const layout = panelSections(style).find((section) => section.group === 'layout');
  if (layout?.mode !== 'edit') return null;
  const padding = {
    top: draft.layout?.padding?.top ?? current.padding.top,
    right: draft.layout?.padding?.right ?? current.padding.right,
    bottom: draft.layout?.padding?.bottom ?? current.padding.bottom,
    left: draft.layout?.padding?.left ?? current.padding.left,
  };
  const border = current.border.style === 'none' ? 0 : current.border.width;
  const box = {
    left: anchor.left + border,
    top: anchor.top + border,
    width: Math.max(0, anchor.width - border * 2),
    height: Math.max(0, anchor.height - border * 2),
  };
  const bands = paddingBands(box, padding);
  const gap = {
    row: draft.layout?.gap?.row ?? current.gap.row,
    column: draft.layout?.gap?.column ?? current.gap.column,
  };
  const slots = current.flow ? gapSlots(controller.childRects()) : [];
  const held = heldSpacing(style, screen);
  const axes = (['column', 'row'] as const)
    .filter((axis) => !held.has(axis))
    .map((axis) => slots.find((slot) => slot.axis === axis))
    .filter((slot): slot is GapSlot => slot !== undefined);
  const sides = SIDES.filter((side) => !held.has(side));
  return (
    <>
      {SIDES.map((side) => (
        <div
          key={`band-${side}`}
          aria-hidden="true"
          className="fixed bg-pink-500/15"
          style={bands[side]}
        />
      ))}
      {slots.map((slot) => (
        <div
          key={`slot-${slot.axis}-${slot.rect.left}-${slot.rect.top}`}
          aria-hidden="true"
          className="fixed bg-pink-500/15"
          style={slot.rect}
        />
      ))}
      {sides.map((side) => (
        <Handle
          key={side}
          target={side}
          band={bands[side]}
          value={padding[side]}
          style={style}
          controller={controller}
        />
      ))}
      {axes.map((slot) => (
        <Handle
          key={`gap-${slot.axis}`}
          target={slot.axis}
          band={slot.rect}
          value={gap[slot.axis]}
          style={style}
          controller={controller}
        />
      ))}
    </>
  );
}
