import type { ElementStyle, StyleToken } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  chooseDrawTarget,
  clamp,
  cssColor,
  droppedNote,
  fillOfToken,
  hexOfComputedColor,
  OPACITY_RANGE,
  panelSections,
  parseHex,
  placePopover,
  RADIUS_RANGE,
  radiusOfToken,
} from './model';

const token = (raw: string, group: StyleToken['group'], editable = true): StyleToken => ({
  token: raw,
  group,
  property: 'x',
  variants: [],
  editable,
});

const style = (overrides: Partial<ElementStyle>): ElementStyle => ({
  file: 'src/A.tsx',
  line: 3,
  column: 5,
  tag: 'button',
  baseHash: '0'.repeat(64),
  classSource: 'static',
  tokens: [],
  theme: { colors: [], radii: [] },
  ...overrides,
});

const summary = (value: ElementStyle) =>
  panelSections(value).map((section) => `${section.group}:${section.mode}`);

describe('parseHex', () => {
  it.each([
    ['1d4ed8', '#1D4ED8'],
    ['#1D4ED8', '#1D4ED8'],
    ['  #abcdef ', '#ABCDEF'],
  ])('accepts %s', (input, expected) => {
    expect(parseHex(input)).toBe(expected);
  });

  it.each(['', '#12345', '1234567', 'red', '#ggg000'])('rejects %s', (input) => {
    expect(parseHex(input)).toBeNull();
  });
});

describe('clamp', () => {
  it('keeps values inside the documented ranges', () => {
    expect(clamp(1200, RADIUS_RANGE)).toBe(999);
    expect(clamp(-4, RADIUS_RANGE)).toBe(0);
    expect(clamp(55, OPACITY_RANGE)).toBe(55);
  });
});

describe('computed colours', () => {
  it('reads rgb and rgba into hex and percent opacity', () => {
    expect(hexOfComputedColor('rgb(190, 18, 60)')).toEqual({ hex: '#BE123C', opacity: 100 });
    expect(hexOfComputedColor('rgba(29, 78, 216, 0.5)')).toEqual({ hex: '#1D4ED8', opacity: 50 });
    expect(hexOfComputedColor('oklch(0.5 0.1 20)')).toBeNull();
  });

  it('writes hex and opacity back as rgba', () => {
    expect(cssColor({ hex: '#1D4ED8', opacity: 80 })).toBe('rgba(29, 78, 216, 0.8)');
  });
});

describe('values written in source', () => {
  const valued = (raw: string, group: StyleToken['group'], value?: string): StyleToken =>
    value === undefined ? token(raw, group) : { ...token(raw, group), value };

  it('reads a fill token as hex with the opacity modifier', () => {
    expect(fillOfToken(valued('bg-brand', 'fill', '#be123c'))).toEqual({
      hex: '#BE123C',
      opacity: 100,
    });
    expect(fillOfToken(valued('bg-[#1D4ED8]/80', 'fill', '#1D4ED8'))).toEqual({
      hex: '#1D4ED8',
      opacity: 80,
    });
  });

  it('leaves colours that are not hex, and missing tokens, to the computed style', () => {
    expect(fillOfToken(valued('bg-blue-600', 'fill', 'oklch(54.6% 0.245 262.881)'))).toBeNull();
    expect(fillOfToken(valued('bg-surface', 'fill'))).toBeNull();
    expect(fillOfToken(undefined)).toBeNull();
  });

  it('reads px radii and leaves other units to the computed style', () => {
    expect(radiusOfToken(valued('rounded-lg', 'radius', '8px'))).toBe(8);
    expect(radiusOfToken(valued('rounded-[1rem]', 'radius', '1rem'))).toBeNull();
    expect(radiusOfToken(undefined)).toBeNull();
  });
});

describe('panelSections', () => {
  it('opens used groups, offers writable unused ones, and hides the rest', () => {
    const button = style({
      tokens: [
        token('bg-brand', 'fill'),
        token('text-white', 'text'),
        token('rounded-lg', 'radius'),
      ],
    });

    expect(summary(button)).toEqual(['radius:edit', 'fill:edit', 'text:readonly']);
  });

  it('offers fill and radius as additions on an element without them', () => {
    expect(summary(style({ tag: 'section', classSource: 'none' }))).toEqual([
      'radius:add',
      'fill:add',
    ]);
  });

  it('shows groups set only by conditions or variants read-only', () => {
    const conditional = style({
      classSource: 'call',
      tokens: [token('hover:bg-red-500', 'fill', false), token('border', 'stroke')],
    });

    expect(summary(conditional)).toEqual(['radius:add', 'fill:readonly', 'stroke:readonly']);
  });

  it('makes everything read-only and offers nothing when the className is dynamic', () => {
    const dynamic = style({ classSource: 'dynamic', tokens: [] });

    expect(summary(dynamic)).toEqual([]);
  });

  it('leaves text out for elements that cannot hold text', () => {
    const image = style({ tag: 'img', tokens: [token('text-sm', 'text')] });

    expect(summary(image)).toEqual(['radius:add', 'fill:add']);
  });
});

describe('placePopover', () => {
  const viewport = { width: 1440, height: 900 };
  const popover = { width: 320, height: 400 };

  it('opens to the right of the element when there is room', () => {
    expect(
      placePopover({ left: 100, top: 300, width: 160, height: 48 }, popover, viewport),
    ).toEqual({
      left: 272,
      top: 300,
      side: 'right',
    });
  });

  it('falls back to the left, then below, and stays inside the viewport', () => {
    expect(
      placePopover({ left: 1200, top: 700, width: 200, height: 40 }, popover, viewport),
    ).toEqual({
      left: 868,
      top: 488,
      side: 'left',
    });
    expect(placePopover({ left: 0, top: 10, width: 1440, height: 60 }, popover, viewport)).toEqual({
      left: 12,
      top: 82,
      side: 'below',
    });
  });
});

describe('chooseDrawTarget', () => {
  const button = { left: 48, top: 276, width: 140, height: 48 };
  const row = { left: 48, top: 276, width: 400, height: 48 };
  const section = { left: 0, top: 100, width: 1280, height: 400 };

  it('picks the element a loose circle encloses, not its container', () => {
    const circle = boundsOf([
      { x: 30, y: 300 },
      { x: 118, y: 255 },
      { x: 210, y: 300 },
      { x: 118, y: 345 },
    ]);

    expect(chooseDrawTarget(circle, [button, row, section])).toBe(0);
  });

  it('picks the largest element a mark encloses', () => {
    const aroundRow = { left: 40, top: 268, width: 420, height: 64 };

    expect(chooseDrawTarget(aroundRow, [button, row, section])).toBe(1);
  });

  it('picks the smallest element under a scribble or a tap', () => {
    const scribble = { left: 80, top: 290, width: 40, height: 20 };
    const tap = { left: 100, top: 300, width: 0, height: 0 };

    expect(chooseDrawTarget(scribble, [section, row, button])).toBe(2);
    expect(chooseDrawTarget(tap, [section, row, button])).toBe(2);
  });

  it('finds nothing when the mark is mostly outside every element', () => {
    const offToTheSide = { left: 1000, top: 600, width: 200, height: 100 };

    expect(chooseDrawTarget(offToTheSide, [button, row, section])).toBeNull();
  });
});

describe('droppedNote', () => {
  it('says how many variants were dropped and why the first one was', () => {
    expect(droppedNote([])).toBeNull();
    expect(droppedNote([{ label: 'Deep', reason: 'op 0: the snippet occurs 0 times' }])).toBe(
      '1 variant was dropped: op 0: the snippet occurs 0 times',
    );
    expect(droppedNote([{ reason: 'It is the same as another variant.' }, { reason: 'x' }])).toBe(
      '2 variants were dropped: It is the same as another variant.',
    );
  });
});
