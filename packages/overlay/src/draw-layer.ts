import { boundsOf, type Point, type Rect } from './model';
import { IDLE_RECORDING, type PointerInput, record } from './stroke-recorder';

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
  let recording = IDLE_RECORDING;
  let frame = 0;
  let drawing = false;

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
    strokePath(context, recording.points);
  }

  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(paint);
  }

  function feed(input: PointerInput): void {
    const next = record(recording, input);
    if (next.recording === recording && next.strokes.length === 0) return;
    recording = next.recording;
    for (const stroke of next.strokes) {
      finished = [...finished, stroke];
      onStroke(stroke, boundsOf(stroke));
    }
    schedule();
  }

  function pointOf(event: PointerEvent): Point {
    return { x: event.clientX, y: event.clientY };
  }

  canvas.addEventListener('pointerdown', (event) => {
    feed({
      kind: 'down',
      pointerId: event.pointerId,
      isPrimary: event.isPrimary,
      button: event.button,
      point: pointOf(event),
    });
    if (recording.pointerId === event.pointerId) canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    feed({
      kind: 'move',
      pointerId: event.pointerId,
      pressed: (event.buttons & 1) === 1,
      points: (event.getCoalescedEvents?.() ?? [event]).map(pointOf),
    });
  });
  canvas.addEventListener('pointerup', (event) => {
    feed({ kind: 'up', pointerId: event.pointerId, point: pointOf(event) });
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointercancel', (event) => {
    feed({ kind: 'cancel', pointerId: event.pointerId });
  });

  function show(visible: boolean): void {
    if (visible === !canvas.hidden) return;
    canvas.hidden = !visible;
    if (visible) {
      resize();
      window.addEventListener('resize', resize);
    } else {
      window.removeEventListener('resize', resize);
    }
  }

  function clear(): void {
    finished = [];
    recording = IDLE_RECORDING;
    show(drawing);
    schedule();
  }

  return {
    enable(): void {
      drawing = true;
      canvas.dataset.drawing = '';
      show(true);
      schedule();
    },
    disable(): void {
      drawing = false;
      delete canvas.dataset.drawing;
      recording = IDLE_RECORDING;
      show(finished.length > 0);
      schedule();
    },
    keepOnly(strokes: readonly Point[][]): void {
      finished = [...strokes];
      show(drawing || finished.length > 0);
      schedule();
    },
    clear,
  };
}
