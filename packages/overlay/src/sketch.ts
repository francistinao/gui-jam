import type { SketchImage } from '@guijam/contracts-ts';
import { domToCanvas } from 'modern-screenshot';
import { strokePath } from './draw-layer';
import type { Point, Rect } from './model';

const MAX_SIDE = 1568;
const PADDING = 24;
const JPEG_QUALITY = 0.85;
const ASSET_TIMEOUT_MS = 5_000;

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return [canvas, context];
}

function fitted(source: HTMLCanvasElement): HTMLCanvasElement {
  const ratio = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  if (ratio === 1) return source;
  const [canvas, context] = canvasOf(source.width * ratio, source.height * ratio);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function encoded(canvas: HTMLCanvasElement, mediaType: SketchImage['mediaType']): SketchImage {
  const url = fitted(canvas).toDataURL(mediaType, JPEG_QUALITY);
  return { mediaType, base64: url.slice(url.indexOf(',') + 1) };
}

async function pageWithStrokes(
  strokes: readonly Point[][],
  exclude: Element,
): Promise<SketchImage | null> {
  try {
    const page = await domToCanvas(document.documentElement, {
      filter: (node) => node !== exclude,
      scale: 1,
      timeout: ASSET_TIMEOUT_MS,
    });
    const [view, context] = canvasOf(window.innerWidth, window.innerHeight);
    context.drawImage(
      page,
      window.scrollX,
      window.scrollY,
      view.width,
      view.height,
      0,
      0,
      view.width,
      view.height,
    );
    for (const stroke of strokes) strokePath(context, stroke);
    return encoded(view, 'image/jpeg');
  } catch {
    return null;
  }
}

function strokesAlone(strokes: readonly Point[][], bounds: Rect): SketchImage {
  const [canvas, context] = canvasOf(bounds.width + PADDING * 2, bounds.height + PADDING * 2);
  context.translate(PADDING - bounds.left, PADDING - bounds.top);
  for (const stroke of strokes) strokePath(context, stroke);
  return encoded(canvas, 'image/png');
}

export async function captureSketch(
  strokes: readonly Point[][],
  bounds: Rect,
  exclude: Element,
): Promise<[SketchImage] | [SketchImage, SketchImage]> {
  const alone = strokesAlone(strokes, bounds);
  const page = await pageWithStrokes(strokes, exclude);
  return page ? [page, alone] : [alone];
}
