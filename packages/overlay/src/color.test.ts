import { describe, expect, it } from 'vitest';
import {
  channels,
  hexToHsv,
  hexToRgb,
  hslToHsv,
  hsvToHex,
  hsvToHsl,
  rgbToHex,
  withChannel,
} from './color';

describe('color conversions', () => {
  it('reads and writes hex as uppercase rgb', () => {
    expect(hexToRgb('#6699cc')).toEqual({ r: 102, g: 153, b: 204 });
    expect(rgbToHex({ r: 102, g: 153, b: 204 })).toBe('#6699CC');
    expect(rgbToHex({ r: 300, g: -4, b: 12.6 })).toBe('#FF000D');
  });

  it('turns hsb into hex and back', () => {
    expect(hsvToHex({ h: 210, s: 50, v: 80 })).toBe('#6699CC');
    expect(hexToHsv('#FF0000')).toEqual({ h: 0, s: 100, v: 100 });
    expect(hsvToHex({ h: 360, s: 100, v: 100 })).toBe('#FF0000');
    for (const hex of ['#BE123C', '#1D4ED8', '#FDE68A', '#3B2418', '#FFFFFF']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('keeps the hue on grays and black, and the saturation on black', () => {
    const previous = { h: 210, s: 60, v: 70 };
    expect(hexToHsv('#000000', previous)).toEqual({ h: 210, s: 60, v: 0 });
    const gray = hexToHsv('#808080', previous);
    expect(gray.h).toBe(210);
    expect(gray.s).toBe(0);
  });

  it('converts between hsb and hsl', () => {
    expect(hsvToHsl({ h: 0, s: 100, v: 100 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(hslToHsv({ h: 0, s: 100, l: 50 })).toEqual({ h: 0, s: 100, v: 100 });
    expect(hsvToHsl({ h: 40, s: 0, v: 100 })).toEqual({ h: 40, s: 0, l: 100 });
  });

  it('shows and edits one channel of each mode, clamped to its range', () => {
    const hsv = hexToHsv('#6699CC');
    expect(channels('rgb', hsv)).toEqual([102, 153, 204]);
    expect(channels('hsl', hsv)).toEqual([210, 50, 60]);
    expect(channels('hsb', hsv)).toEqual([210, 50, 80]);
    expect(hsvToHex(withChannel('rgb', hsv, 0, 255))).toBe('#FF99CC');
    expect(hsvToHex(withChannel('rgb', hsv, 0, 300))).toBe('#FF99CC');
    expect(hsvToHex(withChannel('hsl', hsv, 2, 0))).toBe('#000000');
    expect(withChannel('hsb', hsv, 0, 400).h).toBe(360);
  });
});
