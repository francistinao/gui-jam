import { boundsOf, type Point, type Rect } from './model';

const STROKE_COLOR = '#0d99ff';
const STROKE_WIDTH = 3;

interface DrawLayerOptions {
  /** Where the canvas goes: before the panels, so they paint above it. */
  parent: HTMLElement;
  onStroke(bounds: Rect): void;
}

/**
 * Draw mode covers the page with a canvas, so strokes never reach the page. Points are
 * painted on animation frames instead of re-rendering React per pointer move.
 */
export function createDrawLayer({ parent, onStroke }: DrawLayerOptions) {
  const canvas = document.createElement('canvas');
  canvas.className = 'guijam-draw';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  parent.prepend(canvas);
  const context = canvas.getContext('2d');

  let points: Point[] = [];
  let frame = 0;

  function resize(): void {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function paint(): void {
    frame = 0;
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const [first, ...rest] = points;
    if (!first) return;
    const path = new Path2D();
    path.moveTo(first.x, first.y);
    for (const point of rest) path.lineTo(point.x, point.y);
    context.lineWidth = STROKE_WIDTH;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = STROKE_COLOR;
    context.stroke(path);
  }

  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(paint);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    points = [{ x: event.clientX, y: event.clientY }];
    schedule();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    for (const sample of event.getCoalescedEvents?.() ?? [event]) {
      points.push({ x: sample.clientX, y: sample.clientY });
    }
    schedule();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    canvas.releasePointerCapture(event.pointerId);
    if (points.length > 0) onStroke(boundsOf(points));
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', () => clear());

  function clear(): void {
    points = [];
    schedule();
  }

  return {
    enable(): void {
      resize();
      canvas.hidden = false;
      window.addEventListener('resize', resize);
    },
    disable(): void {
      canvas.hidden = true;
      window.removeEventListener('resize', resize);
      clear();
    },
    clear,
  };
}
