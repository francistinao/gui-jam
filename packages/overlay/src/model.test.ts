import type { ElementStyle, StyleToken } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  changesIn,
  chooseDrawTarget,
  clamp,
  classifyGesture,
  containerIndex,
  cssColor,
  droppedNote,
  fillOfToken,
  formatElapsed,
  hexOfComputedColor,
  invertChanges,
  linksIn,
  MAX_LINKS,
  needsLine,
  OPACITY_RANGE,
  panelSections,
  parseHex,
  placePopover,
  RADIUS_RANGE,
  radiusOfToken,
  shiftedLine,
  splitPaths,
  stillWorking,
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
