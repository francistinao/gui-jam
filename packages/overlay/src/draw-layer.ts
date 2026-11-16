import { boundsOf, type Point, type Rect } from './model';

export const STROKE_COLOR = '#0d99ff';
export const STROKE_WIDTH = 3;

interface DrawLayerOptions {
  parent: HTMLElement;
  onStroke(points: Point[], bounds: Rect): void;
}

export function strokePath(context: CanvasRenderingContext2D, stroke: readonly Point[]): void {
  const [first, ...rest] = stroke;
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

export function createDrawLayer({ parent, onStroke }: DrawLayerOptions) {
  const canvas = document.createElement('canvas');
  canvas.className = 'guijam-draw';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  parent.prepend(canvas);
  const context = canvas.getContext('2d');

  let finished: Point[][] = [];
  let points: Point[] = [];
  let frame = 0;

  function resize(): void {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    schedule();
  }

  function paint(): void {
    frame = 0;
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of finished) strokePath(context, stroke);
    strokePath(context, points);
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
    const stroke = points;
    points = [];
    if (stroke.length === 0) return;
    finished = [...finished, stroke];
    schedule();
    onStroke(stroke, boundsOf(stroke));
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', () => {
    points = [];
    schedule();
  });

  function clear(): void {
    finished = [];
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
    keepOnly(strokes: readonly Point[][]): void {
      finished = [...strokes];
      schedule();
    },
    clear,
  };
}
