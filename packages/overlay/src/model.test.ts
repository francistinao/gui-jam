import type { ElementStyle, StyleToken } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import {
  activeLayers,
  addStroke,
  appliedMessage,
  badgeSpot,
  boundsOf,
  type ComputedLike,
  changesIn,
  chooseDrawTarget,
  clamp,
  clampPanel,
  classifyGesture,
  closesOnEscape,
  closeUpRect,
  containerIndex,
  copiedGroups,
  copiedStyle,
  cssColor,
  currentOf,
  draggedSpacing,
  droppedNote,
  editedFiles,
  fillOfToken,
  finetuneProps,
  followedSrc,
  formatElapsed,
  gapSlots,
  hexOfComputedColor,
  invertChanges,
  isCopyShortcut,
  isPanelSpot,
  keyedParts,
  linksIn,
  MAX_LINKS,
  MAX_TARGETS,
  nearestIndex,
  needsLine,
  nudgePanel,
  OPACITY_RANGE,
  optimisticCss,
  PANEL_EDGE,
  PANEL_MIN_ROOM,
  type Placement,
  type Point,
  paddingBands,
  pagePath,
  panelSections,
  parseHex,
  parseShadows,
  pastDragThreshold,
  pastedDraft,
  placedCopy,
  placeHeldPanel,
  placePopover,
  RADIUS_RANGE,
  type Rect,
  radiusOfToken,
  redoStroke,
  type Size,
  type SketchOwner,
  type SketchState,
  type SketchToggleOwner,
  shiftedLine,
  shownText,
  showsSketchToggle,
  sketchAnchor,
  sketchingOver,
  sketchOver,
  snapSpacing,
  spacingLabel,
  spacingToken,
  splitPaths,
  stillWorking,
  strokeShortcut,
  toggleTarget,
  undoStroke,
  unionRect,
  withoutInstalled,
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
  adapter: 'tailwind',
  styleSource: 'none',
  tokens: [],
  theme: { colors: [], radii: [], fonts: [], textSizes: [], shadows: [], spacing: 4 },
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

    expect(summary(button)).toEqual([
      'layout:edit',
      'radius:edit',
      'fill:edit',
      'stroke:add',
      'text:edit',
      'effects:add',
      'opacity:edit',
    ]);
  });

  it('offers every group without tokens as an addition, and keeps layout, text and opacity open', () => {
    expect(summary(style({ tag: 'section', classSource: 'none' }))).toEqual([
      'layout:edit',
      'radius:add',
      'fill:add',
      'stroke:add',
      'text:edit',
      'effects:add',
      'opacity:edit',
    ]);
  });

  it('shows groups set only by conditions or variants read-only', () => {
    const conditional = style({
      classSource: 'call',
      tokens: [token('hover:bg-red-500', 'fill', false), token('border', 'stroke')],
    });

    expect(summary(conditional)).toEqual([
      'layout:edit',
      'radius:add',
      'fill:readonly',
      'stroke:edit',
      'text:edit',
      'effects:add',
      'opacity:edit',
    ]);
  });

  it('makes everything read-only and offers nothing when the className is dynamic', () => {
    const dynamic = style({ classSource: 'dynamic', tokens: [] });

    expect(summary(dynamic)).toEqual([]);
  });

  it('follows the style object, not the className, for inline styles', () => {
    const inline = style({
      classSource: 'dynamic',
      adapter: 'inline',
      styleSource: 'object',
      tokens: [token("backgroundColor: '#fde68a'", 'fill')],
    });
    expect(summary(inline)).toEqual([
      'layout:edit',
      'radius:add',
      'fill:edit',
      'stroke:add',
      'text:edit',
      'effects:add',
      'opacity:edit',
    ]);

    const computed = style({ adapter: 'inline', styleSource: 'dynamic', tokens: [] });
    expect(summary(computed)).toEqual([]);

    const vuetify = style({
      classSource: 'dynamic',
      adapter: 'vuetify',
      tokens: [token('color="primary"', 'fill')],
    });
    expect(summary(vuetify)).toContain('fill:edit');
    expect(summary(vuetify)).toContain('layout:edit');
  });

  it('leaves text out for elements that cannot hold text', () => {
    const image = style({ tag: 'img', tokens: [token('text-sm', 'text')] });

    expect(summary(image)).not.toContain('text:edit');
    expect(summary(image)).toContain('fill:add');
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

  it('goes above a wide sketch low on the page instead of sliding up over it', () => {
    const sketch = { left: 48, top: 505, width: 960, height: 75 };

    expect(placePopover(sketch, { width: 300, height: 360 }, { width: 1280, height: 720 })).toEqual(
      { left: 48, top: 133, side: 'above' },
    );
  });

  it('uses a corner when no side has room next to the anchor', () => {
    const anchor = { left: 300, top: 200, width: 700, height: 380 };

    const placement = placePopover(
      anchor,
      { width: 300, height: 180 },
      { width: 1280, height: 720 },
    );

    expect(placement.side).toBe('corner');
    expect(covered(placement, { width: 300, height: 180 }, anchor)).toBe(0);
  });

  it('takes below or above, whichever covers less, when the anchor fills the screen', () => {
    const size = { width: 300, height: 360 };
    const screen = { width: 1280, height: 720 };
    const low = { left: 100, top: 80, width: 1100, height: 600 };
    const high = { left: 100, top: 12, width: 1100, height: 560 };

    expect(placePopover(low, size, screen)).toEqual({ left: 100, top: 12, side: 'above' });
    expect(placePopover(high, size, screen)).toEqual({ left: 100, top: 348, side: 'below' });
  });

  function covered(placement: Placement, size: { width: number; height: number }, anchor: Rect) {
    const width =
      Math.min(placement.left + size.width, anchor.left + anchor.width) -
      Math.max(placement.left, anchor.left);
    const height =
      Math.min(placement.top + size.height, anchor.top + anchor.height) -
      Math.max(placement.top, anchor.top);
    return width > 0 && height > 0 ? width * height : 0;
  }

  function roomBeside(anchor: Rect, size: { width: number; height: number }, screen: Size) {
    const gap = 12;
    const usableWidth = screen.width - 2 * gap;
    const usableHeight = screen.height - 2 * gap;
    if (size.width > usableWidth || size.height > usableHeight) return false;
    const leftBand = anchor.left - gap;
    const rightBand = screen.width - gap - (anchor.left + anchor.width);
    const topBand = anchor.top - gap;
    const bottomBand = screen.height - gap - (anchor.top + anchor.height);
    return (
      leftBand >= size.width ||
      rightBand >= size.width ||
      topBand >= size.height ||
      bottomBand >= size.height
    );
  }

  it('never covers the anchor when there is room beside it, and stays on screen', () => {
    const screens = [
      { width: 1280, height: 720 },
      { width: 1024, height: 600 },
    ];
    const sizes = [
      { width: 300, height: 360 },
      { width: 300, height: 520 },
    ];
    let checked = 0;
    for (const screen of screens) {
      for (const size of sizes) {
        for (let left = -40; left <= screen.width; left += 64) {
          for (let top = -40; top <= screen.height; top += 48) {
            for (const width of [24, 180, 420, 760, screen.width]) {
              for (const height of [16, 64, 220, 480]) {
                const anchor = { left, top, width, height };
                const placement = placePopover(anchor, size, screen);
                expect(placement.left).toBeGreaterThanOrEqual(12);
                expect(placement.top).toBeGreaterThanOrEqual(12);
                expect(placement.left + size.width).toBeLessThanOrEqual(screen.width - 12);
                expect(placement.top + size.height).toBeLessThanOrEqual(screen.height - 12);
                if (roomBeside(anchor, size, screen)) {
                  expect(covered(placement, size, anchor), JSON.stringify(anchor)).toBe(0);
                }
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('falls back to below, as it always did, when a full-width element leaves no room', () => {
    const heading = { left: 48, top: 386, width: 1184, height: 28 };

    expect(
      placePopover(heading, { width: 300, height: 520 }, { width: 1280, height: 720 }),
    ).toEqual({ left: 48, top: 188, side: 'below' });
  });

  it('never picks the bottom-right corner, where the GUIJam toolbar sits', () => {
    const screen = { width: 1280, height: 720 };
    const size = { width: 300, height: 360 };
    for (let left = 0; left < 1280; left += 40) {
      for (let top = 0; top < 720; top += 40) {
        const placement = placePopover({ left, top, width: 300, height: 200 }, size, screen);
        const inToolbarCorner = placement.left === 968 && placement.top === 348;
        expect(inToolbarCorner && placement.side === 'corner').toBe(false);
      }
    }
  });

  it('moves aside as a sketch grows toward it, and never onto the sketch', () => {
    const screen = { width: 1280, height: 720 };
    const size = { width: 300, height: 360 };
    const element = { left: 48, top: 560, width: 448, height: 16 };
    const first = placePopover(element, size, screen);
    const stretched = { left: 48, top: 540, width: 560, height: 40 };
    const reaching = { left: 48, top: 505, width: 960, height: 75 };

    const aside = placePopover(stretched, size, screen);
    const above = placePopover(reaching, size, screen);

    expect(first).toEqual({ left: 508, top: 348, side: 'right' });
    expect(aside).toEqual({ left: 620, top: 348, side: 'right' });
    expect(above.side).toBe('above');
    for (const [placement, anchor] of [
      [first, element],
      [aside, stretched],
      [above, reaching],
    ] as const) {
      expect(covered(placement, size, anchor)).toBe(0);
    }
  });
});

describe('placedCopy', () => {
  const at = (src: string) => ({ src, file: src.split(':')[0] ?? '' });

  it('prefers content written inside the copy by the file that holds it', () => {
    expect(
      placedCopy(
        [at('src/components/Icon.tsx:2:10'), at('src/Dashboard.tsx:42:11')],
        at('src/Dashboard.tsx:30:5'),
      ),
    ).toBe('src/Dashboard.tsx:42:11');
  });

  it('takes the first content from another file when the ancestor is a page further out', () => {
    expect(placedCopy([at('src/AnalyticsCard.tsx:12:9')], at('src/Dashboard.tsx:30:5'))).toBe(
      'src/AnalyticsCard.tsx:12:9',
    );
  });

  it('falls back to the nearest ancestor from another file, or nothing', () => {
    expect(placedCopy([], at('src/App.tsx:43:11'))).toBe('src/App.tsx:43:11');
    expect(placedCopy([], undefined)).toBeUndefined();
  });
});

describe('pagePath', () => {
  it('keeps the path, query and hash, and drops the origin', () => {
    expect(pagePath('http://localhost:5173/shop/orders?tab=open#latest')).toBe(
      '/shop/orders?tab=open#latest',
    );
    expect(pagePath('http://localhost:5173/')).toBe('/');
  });
});

describe('badgeSpot', () => {
  const screen = { width: 1280, height: 720 };

  it('sits above the box, ending at its right edge', () => {
    expect(badgeSpot({ left: 100, top: 300, width: 400, height: 80 }, screen)).toEqual({
      right: 500,
      top: 272,
      side: 'above',
    });
  });

  it('goes below a box at the top of the screen, and inside only when neither fits', () => {
    expect(badgeSpot({ left: 100, top: 20, width: 400, height: 80 }, screen)).toEqual({
      right: 500,
      top: 104,
      side: 'below',
    });
    expect(badgeSpot({ left: 0, top: 10, width: 1280, height: 700 }, screen)).toEqual({
      right: 1268,
      top: 12,
      side: 'inside',
    });
  });

  it('keeps room for its label near the left edge and stays on screen at the right', () => {
    expect(badgeSpot({ left: 0, top: 300, width: 30, height: 30 }, screen).right).toBe(108);
    expect(badgeSpot({ left: 1200, top: 300, width: 300, height: 30 }, screen).right).toBe(1268);
  });

  it('stays clear of every box it has room around', () => {
    for (let top = 0; top <= 720; top += 20) {
      for (const height of [10, 100, 300]) {
        const box = { left: 200, top, width: 300, height };
        const spot = badgeSpot(box, screen);
        if (spot.side === 'above') expect(spot.top + 24).toBeLessThanOrEqual(box.top);
        if (spot.side === 'below') expect(spot.top).toBeGreaterThanOrEqual(box.top + box.height);
      }
    }
  });
});

describe('closesOnEscape', () => {
  it('closes on a plain Escape only', () => {
    expect(closesOnEscape({ key: 'Escape', isComposing: false, keyCode: 27 })).toBe(true);
    expect(closesOnEscape({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('leaves Escape to an input method that is composing', () => {
    expect(closesOnEscape({ key: 'Escape', isComposing: true, keyCode: 27 })).toBe(false);
    expect(closesOnEscape({ key: 'Escape', isComposing: false, keyCode: 229 })).toBe(false);
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

describe('splitPaths', () => {
  it('pulls project paths with optional line and column out of an answer', () => {
    expect(
      splitPaths('It is src/assets/logo.png, imported in src/App.tsx:12:7 as `logo`.'),
    ).toEqual([
      { at: 0, text: 'It is ' },
      { at: 6, path: 'src/assets/logo.png' },
      { at: 25, text: ', imported in ' },
      { at: 39, path: 'src/App.tsx:12:7' },
      { at: 55, text: ' as `logo`.' },
    ]);
    expect(splitPaths('No files here.')).toEqual([{ at: 0, text: 'No files here.' }]);
  });
});

describe('classifyGesture', () => {
  const button = { left: 100, top: 100, width: 120, height: 48 };
  const section = { left: 0, top: 0, width: 1200, height: 600 };
  const icon = { left: 600, top: 300, width: 16, height: 16 };
  const loop = (left: number, top: number, width: number, height: number) => [
    { x: left, y: top + 10 },
    { x: left + width, y: top },
    { x: left + width, y: top + height },
    { x: left, y: top + height },
    { x: left + 4, y: top + 14 },
  ];

  it('treats a loop around an element as selecting it', () => {
    expect(classifyGesture(loop(80, 86, 160, 76), [section, button])).toEqual({
      kind: 'select',
      index: 1,
    });
  });

  it('treats open strokes, loops around empty space and loose loops as a sketch', () => {
    const line = [
      { x: 400, y: 300 },
      { x: 700, y: 310 },
    ];
    expect(classifyGesture(line, [section, button])).toEqual({ kind: 'sketch' });
    expect(classifyGesture(loop(500, 250, 300, 120), [section, button])).toEqual({
      kind: 'sketch',
    });
    expect(classifyGesture(loop(500, 250, 300, 120), [section, icon])).toEqual({ kind: 'sketch' });
  });

  it('selects what a tap lands on, and sketches a tap on nothing', () => {
    expect(classifyGesture([{ x: 150, y: 120 }], [section, button])).toEqual({
      kind: 'select',
      index: 1,
    });
    expect(classifyGesture([{ x: 1500, y: 900 }], [section, button])).toEqual({ kind: 'sketch' });
  });
});

describe('containerIndex', () => {
  it('picks the smallest element that holds the whole sketch', () => {
    const page = { left: 0, top: 0, width: 1280, height: 2000 };
    const hero = { left: 48, top: 120, width: 1184, height: 300 };
    const row = { left: 48, top: 276, width: 1184, height: 48 };
    const sketch = { left: 500, top: 260, width: 300, height: 90 };

    expect(containerIndex(sketch, [page, hero, row])).toBe(1);
    expect(containerIndex({ left: -10, top: 0, width: 5, height: 5 }, [hero])).toBeNull();
    expect(unionRect(sketch, row)).toEqual({ left: 48, top: 260, width: 1184, height: 90 });
  });
});

describe('shiftedLine', () => {
  it('moves a line by what a change added or removed above it', () => {
    const changes = [
      { line: 1, before: ['import a;'], after: ['import b;', 'import a;'] },
      { line: 40, before: ['x'], after: ['x', 'y', 'z'] },
    ];
    expect(shiftedLine(30, changes)).toBe(31);
    expect(shiftedLine(50, changes)).toBe(53);
    expect(shiftedLine(1, changes)).toBe(1);
  });

  it('counts only the changes in the selected file when a variant also adds files', () => {
    const changes = [
      { file: 'src/Button.tsx', line: 1, before: [], after: ["import { Plans } from './Plans';"] },
      { file: 'src/components/organisms/Plans.tsx', line: 1, before: [], after: ['a', 'b', 'c'] },
    ];
    expect(changesIn('src/Button.tsx', changes)).toHaveLength(1);
    expect(shiftedLine(3, changesIn('src/Button.tsx', changes))).toBe(4);
    expect(shiftedLine(3, changes)).toBe(7);
  });
});

describe('invertChanges', () => {
  it('maps lines after a change back to where they were', () => {
    const changes = [
      { line: 1, before: ['import a;'], after: ['import b;', 'import a;'] },
      { line: 40, before: ['x'], after: ['x', 'y', 'z'] },
    ];
    const inverted = invertChanges(changes);
    expect(inverted.map((change) => change.line)).toEqual([1, 41]);
    expect(shiftedLine(shiftedLine(50, changes), inverted)).toBe(50);
    expect(shiftedLine(31, inverted)).toBe(30);
  });
});

describe('stillWorking', () => {
  const plain = { sketch: false, images: 0, links: 0, expectedMs: null };

  it('starts plain, then explains the wait in steps', () => {
    expect(stillWorking(0, 60_000, plain)).toBe('Generating…');
    expect(stillWorking(14_999, 60_000, plain)).toBe('Generating…');
    expect(stillWorking(15_000, 60_000, plain)).toBe(
      'Still generating. Most changes take 10 to 40 s.',
    );
    expect(stillWorking(15_000, 180_000, { ...plain, sketch: true })).toBe(
      'Still generating. Sketches and new components usually take 20 to 60 s.',
    );
    expect(stillWorking(45_000, 60_000, plain)).toBe(
      'Still working: the model is writing three takes on your request.',
    );
    expect(stillWorking(90_000, 180_000, plain)).toBe(
      'Taking longer than usual. It stops on its own after 180 s, or Cancel any time.',
    );
    expect(stillWorking(90_000, null, plain)).toBe(
      'Taking longer than usual. You can keep waiting or Cancel any time.',
    );
  });

  it('quotes the measured wait and only calls a run slow against it', () => {
    const opus = { ...plain, sketch: true, expectedMs: 72_400 };

    expect(stillWorking(15_000, 180_000, opus)).toBe(
      'Still generating. With this AI tool and model the first variant usually takes about 72 s.',
    );
    expect(stillWorking(100_000, 180_000, opus)).toBe(
      'Still working on your sketch: laying out the parts and their styles.',
    );
    expect(stillWorking(144_800, 180_000, opus)).toBe(
      'Taking longer than usual. It stops on its own after 180 s, or Cancel any time.',
    );
    expect(stillWorking(15_000, 60_000, { ...plain, expectedMs: 300 })).toBe(
      'Still generating. With this AI tool and model the first variant usually takes about 1 s.',
    );
  });

  it('names the reason that fits the request', () => {
    expect(stillWorking(50_000, 300_000, { ...plain, images: 1 })).toBe(
      'Still working: matching the look of your image.',
    );
    expect(stillWorking(50_000, 300_000, { ...plain, images: 3, sketch: true })).toBe(
      'Still working: matching the look of your 3 images.',
    );
    expect(stillWorking(50_000, 300_000, { ...plain, links: 2 })).toBe(
      'Still working: using what it read from 2 links.',
    );
    expect(stillWorking(50_000, 300_000, { ...plain, sketch: true })).toBe(
      'Still working on your sketch: laying out the parts and their styles.',
    );
  });
});

describe('formatElapsed', () => {
  it('shows seconds, then minutes and padded seconds', () => {
    expect(formatElapsed(-5)).toBe('0 s');
    expect(formatElapsed(999)).toBe('0 s');
    expect(formatElapsed(12_400)).toBe('12 s');
    expect(formatElapsed(59_999)).toBe('59 s');
    expect(formatElapsed(60_000)).toBe('1 min 00 s');
    expect(formatElapsed(125_000)).toBe('2 min 05 s');
  });
});

describe('linksIn', () => {
  const hrefs = (prompt: string) => linksIn(prompt).links.map((link) => link.href);

  it.each([
    ['make it like https://dribbble.com/shots/1.', ['https://dribbble.com/shots/1']],
    ['see (https://example.com/a), then', ['https://example.com/a']],
    ['[ref](https://example.com/b)', ['https://example.com/b']],
    ['<https://example.com/c>', ['https://example.com/c']],
    ['"https://example.com/d"', ['https://example.com/d']],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', ['https://en.wikipedia.org/wiki/Foo_(bar)']],
    ['www.example.com/e!', ['https://www.example.com/e']],
    ['(www.example.com)', ['https://www.example.com/']],
    ['http://127.0.0.1:4173/page?x=1#top', ['http://127.0.0.1:4173/page?x=1']],
    ['ftp://example.com/file', []],
    ['javascript:alert(1) mailto:a@b.co', []],
    ['https:// www. http://', []],
    ['no links at all', []],
    ['', []],
    ['https://a.com https://a.com/ https://a.com#x', ['https://a.com/']],
  ])('%s', (prompt, expected) => {
    expect(hrefs(prompt)).toEqual(expected);
  });

  it('keeps the first three and counts the rest', () => {
    const found = linksIn('https://a.com https://b.com https://c.com https://d.com https://e.com');
    expect(found.links).toHaveLength(MAX_LINKS);
    expect(found.links[2]?.href).toBe('https://c.com/');
    expect(found.skipped).toBe(2);
  });

  it('labels links by host and path without www or a trailing slash', () => {
    const [shot, local, long] = linksIn(
      `https://www.dribbble.com/shots/123/ http://127.0.0.1:4173/ https://example.com/${'a'.repeat(80)}`,
    ).links;
    expect(shot?.label).toBe('dribbble.com/shots/123');
    expect(local?.label).toBe('127.0.0.1:4173');
    expect(long?.label).toHaveLength(40);
    expect(long?.label.endsWith('…')).toBe(true);
  });
});

describe('withoutInstalled', () => {
  const needs = {
    command: 'pnpm add --save-exact three@0.187.0 @react-three/fiber@9.8.2',
    packages: [
      { name: 'three', version: '0.187.0' },
      { name: '@react-three/fiber', version: '9.8.2' },
    ],
  };

  it('drops installed packages and the needs once nothing is left', () => {
    const variant = { label: 'Scene', needs };
    expect(withoutInstalled(variant, new Set(['three'])).needs?.packages).toEqual([
      { name: '@react-three/fiber', version: '9.8.2' },
    ]);
    const done = withoutInstalled(variant, new Set(['three', '@react-three/fiber']));
    expect(done).toEqual({ label: 'Scene' });
    expect('needs' in done).toBe(false);
    const plain: { label: string; needs?: typeof needs } = { label: 'Plain' };
    expect(withoutInstalled(plain, new Set(['three']))).toBe(plain);
  });

  it('says what a variant needs in plain words', () => {
    expect(needsLine(needs)).toBe(
      "Needs three 0.187.0, @react-three/fiber 9.8.2. It isn't previewed until you install them.",
    );
    expect(needsLine({ ...needs, packages: needs.packages.slice(0, 1) })).toBe(
      "Needs three 0.187.0. It isn't previewed until you install it.",
    );
  });
});

describe('sketching over a selected element', () => {
  const element: Rect = { left: 100, top: 200, width: 140, height: 48 };
  const owner = (
    sketch: SketchState | null,
    status: SketchOwner['generation']['status'] = 'idle',
  ): SketchOwner => ({ sketch, generation: { status } });

  it('turns drawing on for the Draw tool or while sketching over, and Select off while sketching', () => {
    expect(activeLayers(null, false)).toEqual({ select: false, draw: false });
    expect(activeLayers(null, true)).toEqual({ select: false, draw: true });
    expect(activeLayers('select', false)).toEqual({ select: true, draw: false });
    expect(activeLayers('select', true)).toEqual({ select: false, draw: true });
    expect(activeLayers('draw', false)).toEqual({ select: false, draw: true });
    expect(activeLayers('draw', true)).toEqual({ select: false, draw: true });
  });

  it('sketches over only an idle prompt job that has a selected element', () => {
    const over = sketchOver(element);
    expect(sketchingOver('prompt', owner(over))).toBe(true);
    expect(sketchingOver('finetune', owner(over))).toBe(false);
    expect(sketchingOver('prompt', owner(over, 'running'))).toBe(false);
    expect(sketchingOver('prompt', owner(over, 'ready'))).toBe(false);
    expect(
      sketchingOver('prompt', owner({ strokes: [[{ x: 1, y: 1 }]], undone: [], bounds: element })),
    ).toBe(false);
    expect(sketchingOver('prompt', owner(null))).toBe(false);
    expect(sketchingOver('prompt', undefined)).toBe(false);
  });

  it('starts empty on the element, then takes the bounds of the first stroke and grows', () => {
    const empty = sketchOver(element);
    expect(empty.strokes).toEqual([]);
    expect(sketchAnchor(empty)).toEqual(element);

    const inside = [
      { x: 120, y: 210 },
      { x: 150, y: 230 },
    ];
    const first = addStroke(empty, inside, boundsOf(inside));
    expect(first.bounds).toEqual({ left: 120, top: 210, width: 30, height: 20 });
    expect(first.element).toEqual(element);
    expect(sketchAnchor(first)).toEqual(element);

    const outside = [
      { x: 300, y: 190 },
      { x: 340, y: 260 },
    ];
    const second = addStroke(first, outside, boundsOf(outside));
    expect(second.strokes).toEqual([inside, outside]);
    expect(second.bounds).toEqual({ left: 120, top: 190, width: 220, height: 70 });
    expect(sketchAnchor(second)).toEqual({ left: 100, top: 190, width: 240, height: 70 });
  });

  it('anchors an empty-space sketch on its strokes alone', () => {
    const stroke = [
      { x: 10, y: 10 },
      { x: 50, y: 30 },
    ];
    const space: SketchState = { strokes: [stroke], undone: [], bounds: boundsOf(stroke) };
    expect(sketchAnchor(space)).toEqual({ left: 10, top: 10, width: 40, height: 20 });
  });

  describe('undo and redo', () => {
    const left = [
      { x: 120, y: 210 },
      { x: 150, y: 230 },
    ];
    const right = [
      { x: 300, y: 190 },
      { x: 340, y: 260 },
    ];
    const low = [
      { x: 200, y: 400 },
      { x: 210, y: 420 },
    ];
    const drawn = (start: SketchState, strokes: Point[][]) =>
      strokes.reduce((sketch, stroke) => addStroke(sketch, stroke, boundsOf(stroke)), start);

    it('takes strokes off one at a time and puts them back in order', () => {
      const full = drawn(sketchOver(element), [left, right, low]);

      const once = undoStroke(full);
      expect(once.strokes).toEqual([left, right]);
      expect(once.undone).toEqual([low]);
      expect(once.bounds).toEqual(drawn(sketchOver(element), [left, right]).bounds);
      expect(sketchAnchor(once)).toEqual({ left: 100, top: 190, width: 240, height: 70 });

      const twice = undoStroke(once);
      expect(twice.strokes).toEqual([left]);
      expect(twice.undone).toEqual([low, right]);
      expect(twice.bounds).toEqual(boundsOf(left));

      const back = redoStroke(twice);
      expect(back.strokes).toEqual([left, right]);
      expect(back.undone).toEqual([low]);
      expect(redoStroke(back)).toEqual(full);
    });

    it('falls back to the element box once every stroke over it is undone', () => {
      const empty = undoStroke(drawn(sketchOver(element), [left]));
      expect(empty.strokes).toEqual([]);
      expect(empty.undone).toEqual([left]);
      expect(empty.bounds).toEqual(element);
      expect(sketchAnchor(empty)).toEqual(element);
    });

    it('keeps an empty-space sketch where it was when its only stroke is undone', () => {
      const space: SketchState = { strokes: [right], undone: [], bounds: boundsOf(right) };
      const empty = undoStroke(space);
      expect(empty.strokes).toEqual([]);
      expect(empty.bounds).toEqual(boundsOf(right));
      expect(sketchAnchor(empty)).toEqual(boundsOf(right));
      expect(redoStroke(empty)).toEqual(space);
    });

    it('drops the redo history when a new stroke is drawn', () => {
      const undone = undoStroke(undoStroke(drawn(sketchOver(element), [left, right])));
      const next = addStroke(undone, low, boundsOf(low));
      expect(next.strokes).toEqual([low]);
      expect(next.undone).toEqual([]);
      expect(next.bounds).toEqual(boundsOf(low));
    });

    it('returns the same sketch when there is nothing to undo or redo', () => {
      const empty = sketchOver(element);
      expect(undoStroke(empty)).toBe(empty);
      expect(redoStroke(empty)).toBe(empty);
      const full = drawn(empty, [left]);
      expect(redoStroke(full)).toBe(full);
    });
  });

  it.each([
    ['Ctrl+Z', { key: 'z', ctrlKey: true }, 'undo'],
    ['Cmd+Z', { key: 'z', metaKey: true }, 'undo'],
    ['Ctrl+Y', { key: 'y', ctrlKey: true }, 'redo'],
    ['Cmd+Y', { key: 'y', metaKey: true }, 'redo'],
    ['Ctrl+Shift+Z', { key: 'Z', ctrlKey: true, shiftKey: true }, 'redo'],
    ['Cmd+Shift+Z', { key: 'Z', metaKey: true, shiftKey: true }, 'redo'],
    ['Ctrl+Z with Caps Lock', { key: 'Z', ctrlKey: true }, 'undo'],
    ['Z alone', { key: 'z' }, null],
    ['Shift+Z', { key: 'Z', shiftKey: true }, null],
    ['Ctrl+Alt+Z', { key: 'z', ctrlKey: true, altKey: true }, null],
    ['Ctrl+Shift+Y', { key: 'Y', ctrlKey: true, shiftKey: true }, null],
    ['Ctrl+X', { key: 'x', ctrlKey: true }, null],
  ] as const)('reads %s as %s', (_label, pressed, expected) => {
    const keys = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...pressed };
    expect(strokeShortcut(keys)).toBe(expected);
  });

  it('pads the close-up and keeps it inside the viewport', () => {
    const viewport = { width: 1280, height: 720 };
    expect(closeUpRect(element, viewport)).toEqual({
      left: 76,
      top: 176,
      width: 188,
      height: 96,
    });
    expect(closeUpRect({ left: 5, top: 700, width: 60, height: 40 }, viewport)).toEqual({
      left: 0,
      top: 676,
      width: 89,
      height: 44,
    });
    expect(closeUpRect({ left: 10.4, top: 20.6, width: 0, height: 0 }, viewport)).toEqual({
      left: 0,
      top: 0,
      width: 35,
      height: 45,
    });
  });

  it('skips the close-up when it would show almost the whole viewport, or nothing of it', () => {
    const viewport = { width: 1000, height: 800 };
    expect(closeUpRect({ left: 20, top: 20, width: 960, height: 760 }, viewport)).toBeNull();
    expect(closeUpRect({ left: 40, top: 40, width: 800, height: 600 }, viewport)).not.toBeNull();
    expect(closeUpRect({ left: 1200, top: 100, width: 80, height: 40 }, viewport)).toBeNull();
    expect(closeUpRect({ left: 100, top: -300, width: 80, height: 40 }, viewport)).toBeNull();
  });

  it('folds a thousand long strokes into the same bounds as all their points', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const strokes: Point[][] = Array.from({ length: 1000 }, () => {
      const x = next() * 1800 - 200;
      const y = next() * 1200 - 100;
      return Array.from({ length: 100 }, (_, index) => ({
        x: x + Math.sin(index) * next() * 90,
        y: y + Math.cos(index) * next() * 90,
      }));
    });

    const sketch = strokes.reduce(
      (current, stroke) => addStroke(current, stroke, boundsOf(stroke)),
      sketchOver(element),
    );

    expect(sketch.strokes).toHaveLength(1000);
    const all = boundsOf(strokes.flat());
    expect(sketch.bounds.left).toBeCloseTo(all.left, 9);
    expect(sketch.bounds.top).toBeCloseTo(all.top, 9);
    expect(sketch.bounds.width).toBeCloseTo(all.width, 9);
    expect(sketch.bounds.height).toBeCloseTo(all.height, 9);
    expect(sketchAnchor(sketch)).toEqual(unionRect(element, sketch.bounds));
  });
});

describe('editedFiles', () => {
  const change = (file: string) => ({ file, line: 1, before: [], after: [] });

  it('lists every existing file a variant changes, without the files it creates', () => {
    expect(
      editedFiles({
        file: 'src/components/OrderButton.tsx',
        changes: [
          change('src/App.tsx'),
          change('src/App.tsx'),
          change('src/components/MenuCard.tsx'),
          change('src/components/organisms/Plans.tsx'),
        ],
        created: ['src/components/organisms/Plans.tsx'],
      }),
    ).toEqual(['src/App.tsx', 'src/components/MenuCard.tsx']);
  });

  it('falls back to the selected file when nothing existing changes', () => {
    expect(editedFiles({ file: 'src\\App.tsx', changes: [], created: [] })).toEqual([
      'src/App.tsx',
    ]);
  });
});

describe('appliedMessage', () => {
  it('names one or two files and counts the rest', () => {
    expect(appliedMessage(['src/App.tsx'])).toBe('Applied to App.tsx.');
    expect(appliedMessage(['src/App.tsx', 'src/components/MenuCard.tsx'])).toBe(
      'Applied to App.tsx and MenuCard.tsx.',
    );
    expect(appliedMessage(['src/App.tsx', 'src/A.tsx', 'src/B.tsx'])).toBe(
      'Applied to App.tsx and 2 other files.',
    );
  });
});

describe('nearestIndex', () => {
  const sketch = { left: 600, top: 700, width: 400, height: 200 };

  it('prefers what sits above or below the sketch, then the smallest gap', () => {
    const page = { left: 0, top: 0, width: 1200, height: 640 };
    const sidebar = { left: 1100, top: 690, width: 100, height: 300 };
    const footer = { left: 0, top: 1000, width: 1200, height: 80 };

    expect(nearestIndex(sketch, [sidebar, footer, page])).toBe(2);
    expect(nearestIndex(sketch, [sidebar])).toBe(0);
    expect(nearestIndex(sketch, [])).toBeNull();
  });
});

describe('followedSrc', () => {
  const selection = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
  const change = (file: string, line: number, before: string[], after: string[]) => ({
    file,
    line,
    before,
    after,
  });

  it('follows lines added above the element in its own file', () => {
    expect(
      followedSrc(selection, [change('src/components/OrderButton.tsx', 1, [], ['import x;'])]),
    ).toEqual({ src: 'src/components/OrderButton.tsx:4:5', touched: false });
  });

  it('keeps the place when only another file changes', () => {
    expect(followedSrc(selection, [change('src/App.tsx', 37, ['<OrderButton />'], [])])).toEqual({
      src: 'src/components/OrderButton.tsx:3:5',
      touched: false,
    });
  });

  it('says when a change covers the element line itself', () => {
    expect(
      followedSrc(selection, [
        change('src/components/OrderButton.tsx', 3, ['    <button>'], ['    <a>']),
      ]).touched,
    ).toBe(true);
  });
});

describe('toggleTarget', () => {
  const at = (src: string) => ({ src });
  const [a, b, c] = [at('src/A.tsx:1:1'), at('src/B.tsx:2:1'), at('src/C.tsx:3:1')];

  it('adds a new component at the end', () => {
    expect(toggleTarget([a], b)).toEqual({ targets: [a, b] });
    expect(toggleTarget([a, b], c)).toEqual({ targets: [a, b, c] });
  });

  it('removes a component picked again, by its source, even the first one', () => {
    expect(toggleTarget([a, b, c], at(b.src))).toEqual({ targets: [a, c] });
    expect(toggleTarget([a, b], a)).toEqual({ targets: [b] });
  });

  it('keeps the last one', () => {
    const only = [a];
    const result = toggleTarget(only, at(a.src));
    expect(result).toEqual({ targets: [a] });
    expect('targets' in result && result.targets).toBe(only);
  });

  it(`stops at ${MAX_TARGETS} components but still lets one be removed`, () => {
    const five = Array.from({ length: MAX_TARGETS }, (_, index) => at(`src/F${index}.tsx:1:1`));
    expect(toggleTarget(five, a)).toEqual({ full: true });
    expect(toggleTarget(five, at('src/F2.tsx:1:1'))).toEqual({
      targets: five.filter((target) => target.src !== 'src/F2.tsx:1:1'),
    });
  });
});

describe('finetuneProps', () => {
  it('sends only what the draft sets, with text edits as runs in order', () => {
    expect(finetuneProps({})).toEqual({});
    expect(
      finetuneProps({
        fill: { kind: 'token', name: 'brand' },
        content: { 2: 'tail', 0: 'Hello' },
      }),
    ).toEqual({
      fill: { kind: 'token', name: 'brand' },
      content: [
        { run: 0, value: 'Hello' },
        { run: 2, value: 'tail' },
      ],
    });
    expect(finetuneProps({ content: {} })).toEqual({});
  });

  it('sends the new style groups', () => {
    expect(
      finetuneProps({
        text: { size: 18 },
        layout: { padding: { top: 16 } },
        opacity: 80,
      }),
    ).toEqual({ text: { size: 18 }, layout: { padding: { top: 16 } }, opacity: 80 });
  });

  it('sends the chosen place of found text with its new value', () => {
    expect(
      finetuneProps({
        source: {
          place: { file: 'src/i18n/en.json', line: 3, column: 14, label: 'footer.hours' },
          value: 'Open 7 to 7',
        },
      }),
    ).toEqual({
      source: { file: 'src/i18n/en.json', line: 3, column: 14, value: 'Open 7 to 7' },
    });
  });
});

describe('shownText', () => {
  it('collapses whitespace and caps the text an instance shows at 500 characters', () => {
    expect(shownText('  CBPLD\n    Overview  ')).toBe('CBPLD Overview');
    expect(shownText(' \n\t ')).toBeUndefined();
    expect(shownText(null)).toBeUndefined();
    expect(shownText('오늘의 추천')).toBe('오늘의 추천');
    expect(shownText('a'.repeat(600))).toHaveLength(500);
  });
});

describe('keyedParts', () => {
  it('gives equal parts different keys that stay the same between renders', () => {
    const parts = [
      { kind: 'code', source: '{x}' },
      { kind: 'element', tag: 'b' },
      { kind: 'code', source: '{x}' },
    ];
    const keys = keyedParts(parts).map(({ key }) => key);
    expect(new Set(keys).size).toBe(3);
    expect(keyedParts(parts).map(({ key }) => key)).toEqual(keys);
  });
});

describe('clampPanel', () => {
  const panel = { width: 300, height: 400 };
  const viewport = { width: 1280, height: 800 };

  it('leaves a panel that fits where it was dropped', () => {
    expect(clampPanel({ left: 500, top: 200 }, panel, viewport)).toEqual({ left: 500, top: 200 });
  });

  it('pulls a panel dragged past the right or bottom edge back inside, with the edge gap', () => {
    expect(clampPanel({ left: 1200, top: 700 }, panel, viewport)).toEqual({
      left: 1280 - 300 - PANEL_EDGE,
      top: 800 - 400 - PANEL_EDGE,
    });
  });

  it('pulls a panel dragged past the left or top edge back inside', () => {
    expect(clampPanel({ left: -250, top: -90 }, panel, viewport)).toEqual({
      left: PANEL_EDGE,
      top: PANEL_EDGE,
    });
  });

  it('pins the top at the edge when the panel is taller than the window, so the header stays reachable', () => {
    expect(clampPanel({ left: 40, top: 300 }, { width: 300, height: 900 }, viewport)).toEqual({
      left: 40,
      top: PANEL_EDGE,
    });
  });

  it('pins a panel at the top left edge of a window narrower and shorter than it', () => {
    expect(clampPanel({ left: 90, top: 90 }, panel, { width: 200, height: 150 })).toEqual({
      left: PANEL_EDGE,
      top: PANEL_EDGE,
    });
  });

  it('rounds to whole pixels', () => {
    expect(clampPanel({ left: 100.4, top: 99.6 }, panel, viewport)).toEqual({
      left: 100,
      top: 100,
    });
  });
});

describe('placeHeldPanel', () => {
  const viewport = { width: 1280, height: 800 };

  it('keeps a moved panel where it was dropped and lets it use the room below', () => {
    expect(placeHeldPanel({ left: 400, top: 100 }, { width: 300, height: 300 }, viewport)).toEqual({
      left: 400,
      top: 100,
      maxHeight: 800 - 100 - PANEL_EDGE,
    });
  });

  it('does not move a dropped panel when it grows, it scrolls inside the room it has', () => {
    const dropped = { left: 400, top: 450 };
    const small = placeHeldPanel(dropped, { width: 300, height: 200 }, viewport);
    const grown = placeHeldPanel(dropped, { width: 300, height: 700 }, viewport);
    expect(grown).toEqual(small);
    expect(grown.maxHeight).toBe(800 - 450 - PANEL_EDGE);
  });

  it('lifts a panel parked too low so it keeps at least the minimum room', () => {
    const placed = placeHeldPanel({ left: 400, top: 760 }, { width: 300, height: 500 }, viewport);
    expect(placed.top).toBe(800 - PANEL_MIN_ROOM - PANEL_EDGE);
    expect(placed.maxHeight).toBe(PANEL_MIN_ROOM);
  });

  it('keeps a short panel fully on screen', () => {
    const placed = placeHeldPanel({ left: 400, top: 760 }, { width: 300, height: 120 }, viewport);
    expect(placed.top).toBe(800 - 120 - PANEL_EDGE);
  });

  it('pulls a moved panel back inside when the window shrinks', () => {
    const placed = placeHeldPanel(
      { left: 1100, top: 600 },
      { width: 300, height: 400 },
      {
        width: 900,
        height: 700,
      },
    );
    expect(placed).toEqual({
      left: 900 - 300 - PANEL_EDGE,
      top: 700 - PANEL_MIN_ROOM - PANEL_EDGE,
      maxHeight: PANEL_MIN_ROOM,
    });
  });
});

describe('pastDragThreshold', () => {
  const from = { x: 100, y: 100 };

  it.each([
    [{ x: 100, y: 100 }, false],
    [{ x: 102, y: 100 }, false],
    [{ x: 101, y: 102 }, false],
    [{ x: 103, y: 100 }, true],
    [{ x: 100, y: 97 }, true],
    [{ x: 102.2, y: 102.2 }, true],
  ])('moving to %o is a drag: %s', (to, dragged) => {
    expect(pastDragThreshold(from, to)).toBe(dragged);
  });
});

describe('nudgePanel', () => {
  const spot = { left: 200, top: 150 };

  it.each([
    ['ArrowLeft', false, { left: 190, top: 150 }],
    ['ArrowRight', false, { left: 210, top: 150 }],
    ['ArrowUp', false, { left: 200, top: 140 }],
    ['ArrowDown', false, { left: 200, top: 160 }],
    ['ArrowLeft', true, { left: 150, top: 150 }],
    ['ArrowRight', true, { left: 250, top: 150 }],
    ['ArrowUp', true, { left: 200, top: 100 }],
    ['ArrowDown', true, { left: 200, top: 200 }],
  ])('%s with Shift %s moves the panel to %o', (key, big, moved) => {
    expect(nudgePanel(spot, key, big)).toEqual(moved);
  });

  it('puts the panel back beside its drawing on Home', () => {
    expect(nudgePanel(spot, 'Home', false)).toBe('reset');
    expect(nudgePanel(spot, 'Home', true)).toBe('reset');
  });

  it.each(['Enter', ' ', 'Escape', 'Tab', 'a', 'End'])('ignores %j', (key) => {
    expect(nudgePanel(spot, key, false)).toBeNull();
  });
});

describe('isPanelSpot', () => {
  it.each([
    [{ left: 0, top: 0 }, true],
    [{ left: -4.5, top: 30 }, true],
    [{ left: 4 }, false],
    [{ left: '4', top: 5 }, false],
    [{ left: Number.NaN, top: 5 }, false],
    [{ left: 4, top: Number.POSITIVE_INFINITY }, false],
    [null, false],
    ['4,5', false],
  ])('%o is a panel spot: %s', (value, valid) => {
    expect(isPanelSpot(value)).toBe(valid);
  });
});

describe('showsSketchToggle', () => {
  const stroke = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ];
  const owner = (
    status: SketchToggleOwner['generation']['status'],
    variants: number,
    strokes: unknown[] = [stroke],
  ): SketchToggleOwner => ({
    strokes,
    generation: { status, variants: Array.from({ length: variants }, (_, index) => index) },
  });

  it('shows once variants are shown for a drawing with strokes', () => {
    expect(showsSketchToggle(owner('ready', 3))).toBe(true);
  });

  it('shows as soon as the first variant arrives while the others are still generating', () => {
    expect(showsSketchToggle(owner('running', 1))).toBe(true);
  });

  it('stays away while sketching, before anything came back, and for an answer without variants', () => {
    expect(showsSketchToggle(owner('idle', 0))).toBe(false);
    expect(showsSketchToggle(owner('running', 0))).toBe(false);
    expect(showsSketchToggle(owner('ready', 0))).toBe(false);
  });

  it('stays away for an Ask AI drawing with no strokes', () => {
    expect(showsSketchToggle(owner('ready', 3, []))).toBe(false);
  });

  it('stays away for variants left over on a drawing that went back to sketching', () => {
    expect(showsSketchToggle(owner('idle', 3))).toBe(false);
  });
});

const computed = (overrides: Partial<ComputedLike>): ComputedLike => ({
  backgroundColor: 'rgba(0, 0, 0, 0)',
  borderTopLeftRadius: '8px',
  color: 'rgb(255, 255, 255)',
  fontSize: '16px',
  fontWeight: '500',
  lineHeight: '24px',
  letterSpacing: 'normal',
  textAlign: 'start',
  borderTopWidth: '0px',
  borderTopStyle: 'solid',
  borderTopColor: 'rgb(0, 0, 0)',
  boxShadow: 'none',
  opacity: '1',
  paddingTop: '12px',
  paddingRight: '24px',
  paddingBottom: '12px',
  paddingLeft: '24px',
  rowGap: 'normal',
  columnGap: 'normal',
  display: 'block',
  flexDirection: 'row',
  ...overrides,
});

describe('currentOf', () => {
  it('reads typography, padding and flow from computed styles', () => {
    const current = currentOf(computed({ letterSpacing: '0.4px', display: 'flex', rowGap: '8px' }));
    expect(current.fontSize).toBe(16);
    expect(current.fontWeight).toBe(500);
    expect(current.letterSpacing).toBe(0.025);
    expect(current.align).toBe('left');
    expect(current.padding).toEqual({ top: 12, right: 24, bottom: 12, left: 24 });
    expect(current.gap).toEqual({ row: 8, column: 0 });
    expect(current.flow).toBe('row');
    expect(current.opacity).toBe(100);
    expect(currentOf(computed({ display: 'inline-grid' })).flow).toBe('grid');
    expect(currentOf(computed({ display: 'flex', flexDirection: 'column' })).flow).toBe('column');
    expect(currentOf(computed({ lineHeight: 'normal' })).lineHeight).toBeNull();
  });
});

describe('parseShadows', () => {
  it('reads computed and theme shadows and skips transparent and ring layers', () => {
    expect(
      parseShadows(
        'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(59, 130, 246) 0px 0px 0px 2px, rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.05) 0px 2px 4px 0px inset',
      ),
    ).toEqual({
      drop: { x: 0, y: 4, blur: 6, spread: -1, hex: '#000000', opacity: 10 },
      inner: { x: 0, y: 2, blur: 4, spread: 0, hex: '#000000', opacity: 5 },
    });
    expect(
      parseShadows('0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)').drop,
    ).toEqual({
      x: 0,
      y: 1,
      blur: 3,
      spread: 0,
      hex: '#000000',
      opacity: 10,
    });
    expect(parseShadows('none')).toEqual({ drop: null, inner: null });
  });
});

describe('optimisticCss', () => {
  it('turns a draft into CSS properties for the live element', () => {
    const tokens = style({
      theme: {
        colors: [{ name: 'brand', value: '#BE123C' }],
        radii: [],
        fonts: [],
        textSizes: [],
        shadows: [{ name: 'sm', value: '0 1px 3px 0 rgb(0 0 0 / 0.1)', inset: false }],
        spacing: 4,
      },
    });
    expect(
      optimisticCss(
        {
          text: { size: 18, align: 'center', color: { kind: 'token', name: 'brand' } },
          stroke: { kind: 'set', width: 2 },
          effects: { drop: { kind: 'token', name: 'sm' } },
          opacity: 50,
          layout: { padding: { top: 20 }, gap: { column: 8 } },
        },
        tokens,
      ),
    ).toEqual({
      'font-size': '18px',
      'text-align': 'center',
      color: '#BE123C',
      'border-width': '2px',
      'border-style': 'solid',
      'box-shadow': '0 1px 3px 0 rgb(0 0 0 / 0.1)',
      opacity: '0.5',
      'padding-top': '20px',
      'column-gap': '8px',
    });
    expect(optimisticCss({ effects: {} }, tokens)).toEqual({ 'box-shadow': 'none' });
    expect(optimisticCss({ stroke: { kind: 'none' } }, tokens)).toEqual({ 'border-style': 'none' });
  });
});

describe('spacing', () => {
  it('names the Tailwind token a value lands on', () => {
    expect(spacingToken('pt', 16, 4)).toBe('pt-4');
    expect(spacingToken('pt', 14, 4)).toBe('pt-3.5');
    expect(spacingToken('pt', 13, 4)).toBe('pt-[13px]');
    expect(spacingToken('pt', 1, 4)).toBe('pt-px');
    expect(spacingToken('pt', 0, 4)).toBe('pt-0');
    expect(spacingLabel(16, 'top', style({}))).toBe('16 · pt-4');
    expect(spacingLabel(8, 'column', style({}))).toBe('8 · gap-x-2');
    expect(spacingLabel(16, 'top', style({ adapter: 'inline' }))).toBe('16px');
  });

  it('snaps drags to the spacing step unless fine, and grows padding inward', () => {
    expect(snapSpacing(17, 4, false)).toBe(16);
    expect(snapSpacing(17, 4, true)).toBe(17);
    expect(snapSpacing(-5, 4, false)).toBe(0);
    expect(draggedSpacing(16, 'top', { x: 0, y: 9 }, 4, false)).toBe(24);
    expect(draggedSpacing(16, 'bottom', { x: 0, y: 9 }, 4, false)).toBe(8);
    expect(draggedSpacing(16, 'right', { x: -3, y: 0 }, 4, true)).toBe(19);
    expect(draggedSpacing(8, 'column', { x: 5, y: 0 }, 4, false)).toBe(12);
  });

  it('lays padding bands inside the box and gap slots between children', () => {
    const box = { left: 0, top: 0, width: 100, height: 40 };
    expect(paddingBands(box, { top: 4, right: 8, bottom: 6, left: 10 })).toEqual({
      top: { left: 0, top: 0, width: 100, height: 4 },
      right: { left: 92, top: 0, width: 8, height: 40 },
      bottom: { left: 0, top: 34, width: 100, height: 6 },
      left: { left: 0, top: 0, width: 10, height: 40 },
    });
    expect(
      gapSlots([
        { left: 0, top: 0, width: 40, height: 20 },
        { left: 48, top: 0, width: 40, height: 20 },
        { left: 0, top: 30, width: 40, height: 20 },
      ]),
    ).toEqual([
      { axis: 'column', rect: { left: 40, top: 0, width: 8, height: 20 } },
      { axis: 'row', rect: { left: 0, top: 20, width: 88, height: 10 } },
    ]);
  });
});

describe('copy style', () => {
  const brand = style({
    tag: 'button',
    tokens: [
      {
        token: 'bg-brand',
        group: 'fill',
        property: 'color',
        variants: [],
        themeToken: 'brand',
        value: '#BE123C',
        editable: true,
      },
      {
        token: 'rounded-lg',
        group: 'radius',
        property: 'radius',
        variants: [],
        themeToken: 'lg',
        value: '8px',
        editable: true,
      },
      {
        token: 'text-white',
        group: 'text',
        property: 'color',
        variants: [],
        themeToken: 'white',
        value: '#FFFFFF',
        editable: true,
      },
    ],
    theme: {
      colors: [{ name: 'brand', value: '#BE123C' }],
      radii: [{ name: 'lg', px: 8 }],
      fonts: ['sans'],
      textSizes: [],
      shadows: [],
      spacing: 4,
    },
  });
  const source = currentOf(computed({ backgroundColor: 'rgb(190, 18, 60)', textAlign: 'center' }));

  it('copies theme tokens it can name and computed values for the rest', () => {
    const values = copiedStyle(brand, source);
    expect(values.fill).toEqual({ kind: 'token', name: 'brand' });
    expect(values.radius).toEqual({ kind: 'token', name: 'lg' });
    expect(values.text?.color).toEqual({ kind: 'hex', hex: '#FFFFFF', opacity: 100 });
    expect(values.layout).toEqual({ padding: { top: 12, right: 24, bottom: 12, left: 24 } });
    expect(values.stroke).toBeUndefined();
    expect(values.effects).toBeUndefined();
    expect(values.opacity).toBeUndefined();
    expect(copiedGroups(values)).toEqual(['layout', 'radius', 'fill', 'text']);
  });

  it('pastes only what differs from the target', () => {
    const values = copiedStyle(brand, source);
    const gift = currentOf(
      computed({
        backgroundColor: 'rgb(253, 230, 138)',
        color: 'rgb(0, 0, 0)',
        fontWeight: '400',
        paddingTop: '16px',
        paddingRight: '16px',
        paddingBottom: '16px',
        paddingLeft: '16px',
      }),
    );
    const target = style({ tag: 'p', adapter: 'inline', theme: brand.theme });
    expect(pastedDraft(values, gift, target)).toEqual({
      fill: { kind: 'token', name: 'brand' },
      text: {
        weight: 500,
        align: 'center',
        color: { kind: 'hex', hex: '#FFFFFF', opacity: 100 },
      },
      layout: { padding: { top: 12, right: 24, bottom: 12, left: 24 } },
    });
    expect(pastedDraft(values, source, brand)).toEqual({});
  });

  it('leaves text out of elements that cannot hold it, and gap out of non-flex targets', () => {
    const values = { text: { size: 20 }, layout: { gap: { row: 8, column: 8 } } };
    const image = style({ tag: 'img' });
    expect(pastedDraft(values, currentOf(computed({})), image)).toEqual({});
  });

  it('copies with Alt+Shift+C and nothing else', () => {
    const key = { altKey: true, shiftKey: true, metaKey: false, ctrlKey: false, code: 'KeyC' };
    expect(isCopyShortcut(key)).toBe(true);
    expect(isCopyShortcut({ ...key, metaKey: true })).toBe(false);
    expect(isCopyShortcut({ ...key, shiftKey: false })).toBe(false);
    expect(isCopyShortcut({ ...key, code: 'KeyV' })).toBe(false);
  });
});
