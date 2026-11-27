import { describe, expect, it } from 'vitest';
import {
  currentOf,
  draggedSpacing,
  gapSlots,
  parseShadows,
  snapSpacing,
  spacingToken,
} from './model';

const BLUE_500 = 'oklch(0.623 0.214 259.815)';

describe('reading Tailwind v4 palette colours', () => {
  it('never reads an oklch shadow colour as solid black', () => {
    const { drop } = parseShadows(`${BLUE_500.replace(')', ' / 0.5)')} 0px 4px 6px -1px`);

    expect(drop?.hex).not.toBe('#000000');
  });

  it('never reads an oklch inset shadow colour as solid black', () => {
    const { inner } = parseShadows(`${BLUE_500} 0px 2px 4px 0px inset`);

    expect(inner?.hex).not.toBe('#000000');
  });
});

describe('spacing tokens at the edges of the scale', () => {
  it.each([
    [0.5, 'pt-[0.5px]'],
    [2, 'pt-0.5'],
    [6, 'pt-1.5'],
    [10, 'pt-2.5'],
    [12.5, 'pt-[12.5px]'],
    [998, 'pt-249.5'],
    [999, 'pt-[999px]'],
  ])('%s px is written as %s', (px, token) => {
    expect(spacingToken('pt', px, 4)).toBe(token);
  });

  it('uses the project step instead of 4 px', () => {
    expect(spacingToken('pt', 15, 5)).toBe('pt-3');
    expect(spacingToken('pt', 16, 5)).toBe('pt-[16px]');
  });
});

describe('snapping and dragging', () => {
  it('never leaves the 0 to 999 range', () => {
    expect(snapSpacing(5000, 4, false)).toBe(999);
    expect(snapSpacing(-1, 4, true)).toBe(0);
  });

  it('falls back to whole pixels when the theme has no spacing step', () => {
    expect(snapSpacing(13.4, 0, false)).toBe(13);
  });

  it.each([
    ['top', { x: 0, y: 8 }, 24],
    ['bottom', { x: 0, y: -8 }, 24],
    ['left', { x: 8, y: 0 }, 24],
    ['right', { x: -8, y: 0 }, 24],
    ['row', { x: 0, y: 8 }, 24],
    ['column', { x: 8, y: 0 }, 24],
  ] as const)('dragging %s inward by 8 px grows it from 16 to 24', (side, delta, expected) => {
    expect(draggedSpacing(16, side, delta, 4, false)).toBe(expected);
  });
});

describe('gap slots', () => {
  it('finds the column gap in a reversed row', () => {
    const slots = gapSlots([
      { left: 100, top: 0, width: 40, height: 20 },
      { left: 52, top: 0, width: 40, height: 20 },
    ]);

    expect(slots).toEqual([{ axis: 'column', rect: { left: 92, top: 0, width: 8, height: 20 } }]);
  });

  it('offers a slot between touching children so a zero gap can be opened', () => {
    const slots = gapSlots([
      { left: 0, top: 0, width: 40, height: 20 },
      { left: 40, top: 0, width: 40, height: 20 },
    ]);

    expect(slots).toEqual([{ axis: 'column', rect: { left: 40, top: 0, width: 0, height: 20 } }]);
  });

  it('has no slots for a single child', () => {
    expect(gapSlots([{ left: 0, top: 0, width: 40, height: 20 }])).toEqual([]);
  });
});

describe('currentOf', () => {
  it('reads letter spacing "normal" and a missing font size as zero spacing', () => {
    const current = currentOf({
      ...COMPUTED,
      letterSpacing: 'normal',
      fontSize: '16px',
    });

    expect(current.letterSpacing).toBe(0);
  });

  it('reads column-reverse flex as a column flow', () => {
    expect(currentOf({ ...COMPUTED, display: 'flex', flexDirection: 'column-reverse' }).flow).toBe(
      'column',
    );
    expect(currentOf({ ...COMPUTED, display: 'inline-grid' }).flow).toBe('grid');
    expect(currentOf({ ...COMPUTED, display: 'block' }).flow).toBeNull();
  });
});

const COMPUTED = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  borderTopLeftRadius: '0px',
  color: 'rgb(0, 0, 0)',
  fontSize: '16px',
  fontWeight: '400',
  lineHeight: 'normal',
  letterSpacing: 'normal',
  textAlign: 'start',
  borderTopWidth: '0px',
  borderTopStyle: 'none',
  borderTopColor: 'rgb(0, 0, 0)',
  boxShadow: 'none',
  opacity: '1',
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
  rowGap: 'normal',
  columnGap: 'normal',
  display: 'block',
  flexDirection: 'row',
};
