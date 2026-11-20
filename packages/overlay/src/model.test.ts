import type { ElementStyle, StyleToken } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import {
  activeLayers,
  addStroke,
  appliedMessage,
  boundsOf,
  changesIn,
  chooseDrawTarget,
  clamp,
  classifyGesture,
  closeUpRect,
  containerIndex,
  cssColor,
  droppedNote,
  editedFiles,
  fillOfToken,
  finetuneProps,
  followedSrc,
  formatElapsed,
  hexOfComputedColor,
  invertChanges,
  keyedParts,
  linksIn,
  MAX_LINKS,
  MAX_TARGETS,
  nearestIndex,
  needsLine,
  OPACITY_RANGE,
  type Point,
  panelSections,
  parseHex,
  placePopover,
  RADIUS_RANGE,
  type Rect,
  radiusOfToken,
  redoStroke,
  type SketchOwner,
  type SketchState,
  shiftedLine,
  sketchAnchor,
  sketchingOver,
  sketchOver,
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

  it('follows the style object, not the className, for inline styles', () => {
    const inline = style({
      classSource: 'dynamic',
      adapter: 'inline',
      styleSource: 'object',
      tokens: [token("backgroundColor: '#fde68a'", 'fill')],
    });
    expect(summary(inline)).toEqual(['radius:add', 'fill:edit']);

    const computed = style({ adapter: 'inline', styleSource: 'dynamic', tokens: [] });
    expect(summary(computed)).toEqual([]);

    const vuetify = style({
      classSource: 'dynamic',
      adapter: 'vuetify',
      tokens: [token('color="primary"', 'fill')],
    });
    expect(summary(vuetify)).toEqual(['radius:add', 'fill:edit']);
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
