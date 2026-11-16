export const MAX_ATTACHMENTS = 4;
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_SIDE = 1568;
export const JPEG_QUALITY = 0.85;
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const ALPHA_SAMPLES = 64;
const OPAQUE = 250;

export type EncodedType = 'image/png' | 'image/jpeg';

export interface Attachment {
  id: string;
  name: string;
  mediaType: EncodedType;
  base64: string;
  width: number;
  height: number;
}

export type SourceCheck = { ok: true } | { ok: false; reason: string };

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function checkSource(name: string, type: string, size: number): SourceCheck {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      reason: `${name} isn't an image GUIJam can use. Attach a PNG, JPEG, WebP or GIF.`,
    };
  }
  if (size === 0) return { ok: false, reason: `${name} is empty.` };
  if (size > MAX_SOURCE_BYTES) {
    return { ok: false, reason: `${name} is ${megabytes(size)} MB; images can be up to 20 MB.` };
  }
  return { ok: true };
}

export function fittedSize(
  width: number,
  height: number,
  max = MAX_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > max ? max / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function encodingFor(hasAlpha: boolean): EncodedType {
  return hasAlpha ? 'image/png' : 'image/jpeg';
}

export function roomFor(current: number, adding: number): number {
  return Math.max(0, Math.min(adding, MAX_ATTACHMENTS - current));
}

export function overflowNote(skipped: number): string | null {
  if (skipped <= 0) return null;
  return skipped === 1
    ? `Up to ${MAX_ATTACHMENTS} images fit, so 1 wasn't added. Remove one to add another.`
    : `Up to ${MAX_ATTACHMENTS} images fit, so ${skipped} weren't added. Remove one to add another.`;
}

export function imageFiles(files: Iterable<File>): File[] {
  return [...files].filter((file) => file.type.startsWith('image/'));
}

function hasTransparency(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  const stepX = Math.max(1, Math.floor(width / ALPHA_SAMPLES));
  const stepY = Math.max(1, Math.floor(height / ALPHA_SAMPLES));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      if ((data[(y * width + x) * 4 + 3] ?? 255) < OPAQUE) return true;
    }
  }
  return false;
}

export async function prepareImage(file: File): Promise<Attachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} couldn't be read as an image.`);
  }
  const { width, height } = fittedSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('This browser cannot re-encode images.');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const mediaType = encodingFor(
    file.type !== 'image/jpeg' && hasTransparency(context, width, height),
  );
  const url = canvas.toDataURL(mediaType, JPEG_QUALITY);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType,
    base64: url.slice(url.indexOf(',') + 1),
    width,
    height,
  };
}
