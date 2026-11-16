import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { colorDepth, renderBanner } from './banner.js';

function visibleLines(text: string): string[] {
  return stripVTControlCharacters(text).split('\n');
}

describe('colorDepth', () => {
  it('honours NO_COLOR, dumb terminals and pipes', () => {
    expect(colorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe('none');
    expect(colorDepth({ TERM: 'dumb' }, true)).toBe('none');
    expect(colorDepth({}, false)).toBe('none');
    expect(colorDepth({ FORCE_COLOR: '0' }, true)).toBe('none');
  });

  it('uses 24-bit colour only when the terminal says so', () => {
    expect(colorDepth({ COLORTERM: 'truecolor' }, true)).toBe('truecolor');
    expect(colorDepth({}, true)).toBe('256');
    expect(colorDepth({ FORCE_COLOR: '1' }, false)).toBe('256');
    expect(colorDepth({ NO_COLOR: '' }, true)).toBe('256');
  });
});

describe('renderBanner', () => {
  it('prints plain text without colour', () => {
    const banner = renderBanner({ version: '1.2.3', depth: 'none', columns: 120 });

    expect(banner).toBe('GUIJam v1.2.3\nDraw on your app. Keep what you like.');
  });

  it('puts the wordmark beside the logo within 80 columns', () => {
    const banner = renderBanner({ version: '1.2.3', depth: 'truecolor', columns: 80 });
    const lines = visibleLines(banner);

    expect(lines).toHaveLength(13);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80);
    expect(lines.some((line) => line.endsWith('█▀▀ █ █ █   █ ▄▀█ █▀▄▀█'))).toBe(true);
    expect(lines.some((line) => line.endsWith('v1.2.3'))).toBe(true);
    expect(banner).toContain('38;2;10;155;255');
  });

  it('stacks the wordmark under the logo in narrow terminals', () => {
    const lines = visibleLines(renderBanner({ version: '1.2.3', depth: '256', columns: 40 }));

    expect(lines).toHaveLength(19);
    expect(lines[14]).toBe('█▀▀ █ █ █   █ ▄▀█ █▀▄▀█');
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });
});
