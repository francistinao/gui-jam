export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export type ColorMode = 'hex' | 'rgb' | 'hsl' | 'hsb';

export const COLOR_MODES: readonly { mode: ColorMode; label: string }[] = [
  { mode: 'hex', label: 'Hex' },
  { mode: 'rgb', label: 'RGB' },
  { mode: 'hsl', label: 'HSL' },
  { mode: 'hsb', label: 'HSB' },
];

const within = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (channel: number) =>
    Math.round(within(channel, 0, 255))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

function hueOf({ r, g, b }: Rgb, max: number, delta: number): number {
  const hue =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

export function rgbToHsv(rgb: Rgb, previous: Hsv = { h: 0, s: 0, v: 0 }): Hsv {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (max === 0) return { h: previous.h, s: previous.s, v: 0 };
  if (delta === 0) return { h: previous.h, s: 0, v: max * 100 };
  return { h: hueOf({ r, g, b }, max, delta), s: (delta / max) * 100, v: max * 100 };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const value = within(v, 0, 100) / 100;
  const chroma = value * (within(s, 0, 100) / 100);
  const sector = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const lift = value - chroma;
  return { r: (r + lift) * 255, g: (g + lift) * 255, b: (b + lift) * 255 };
}

export function hsvToHsl({ h, s, v }: Hsv): Hsl {
  const value = v / 100;
  const light = value * (1 - s / 200);
  const saturation = light === 0 || light === 1 ? 0 : (value - light) / Math.min(light, 1 - light);
  return { h, s: saturation * 100, l: light * 100 };
}

export function hslToHsv({ h, s, l }: Hsl): Hsv {
  const light = within(l, 0, 100) / 100;
  const value = light + (within(s, 0, 100) / 100) * Math.min(light, 1 - light);
  return { h, s: value === 0 ? 0 : 2 * (1 - light / value) * 100, v: value * 100 };
}

export function hexToHsv(hex: string, previous?: Hsv): Hsv {
  return rgbToHsv(hexToRgb(hex), previous);
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

export function channels(mode: Exclude<ColorMode, 'hex'>, hsv: Hsv): [number, number, number] {
  if (mode === 'rgb') {
    const { r, g, b } = hsvToRgb(hsv);
    return [Math.round(r), Math.round(g), Math.round(b)];
  }
  if (mode === 'hsl') {
    const { h, s, l } = hsvToHsl(hsv);
    return [Math.round(h), Math.round(s), Math.round(l)];
  }
  return [Math.round(hsv.h), Math.round(hsv.s), Math.round(hsv.v)];
}

export const CHANNEL_RANGES: Record<
  Exclude<ColorMode, 'hex'>,
  readonly [number, number, number]
> = {
  rgb: [255, 255, 255],
  hsl: [360, 100, 100],
  hsb: [360, 100, 100],
};

export function withChannel(
  mode: Exclude<ColorMode, 'hex'>,
  hsv: Hsv,
  index: 0 | 1 | 2,
  value: number,
): Hsv {
  const next: [number, number, number] = [...channels(mode, hsv)];
  next[index] = within(value, 0, CHANNEL_RANGES[mode][index]);
  const [a, b, c] = next;
  if (mode === 'rgb') return rgbToHsv({ r: a, g: b, b: c }, hsv);
  if (mode === 'hsl') return hslToHsv({ h: a, s: b, l: c });
  return { h: a, s: b, v: c };
}
