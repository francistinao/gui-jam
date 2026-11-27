import type { ElementStyle } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import { currentOf, sectionSummary } from './model';
import { parseSections } from './persist';

const COMPUTED = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  borderTopLeftRadius: '0px',
  color: 'rgb(0, 0, 0)',
  fontSize: '16px',
  fontWeight: '400',
  lineHeight: '24px',
  letterSpacing: 'normal',
  textAlign: 'start',
  borderTopWidth: '0px',
  borderTopStyle: 'none',
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
};

const style = (overrides: Partial<ElementStyle> = {}): ElementStyle => ({
  file: 'src/A.tsx',
  line: 3,
  column: 5,
  tag: 'button',
  baseHash: '0'.repeat(64),
  classSource: 'static',
  adapter: 'tailwind',
  styleSource: 'none',
  tokens: [],
  theme: {
    colors: [{ name: 'brand', value: '#BE123C' }],
    radii: [{ name: 'lg', px: 8 }],
    fonts: [],
    textSizes: [],
    shadows: [{ name: 'sm', value: '0 1px 2px 0 rgb(0 0 0 / 0.05)', inset: false }],
    spacing: 4,
  },
  ...overrides,
});

const current = (overrides: Partial<typeof COMPUTED> = {}) =>
  currentOf({ ...COMPUTED, ...overrides });

describe('section summaries', () => {
  it.each([
    ['layout', {}, {}, '12 24 12 24'],
    ['layout', { display: 'flex', rowGap: '8px', columnGap: '8px' }, {}, '12 24 12 24 · gap 8'],
    ['layout', { display: 'grid', rowGap: '8px', columnGap: '16px' }, {}, '12 24 12 24 · gap 8 16'],
    ['layout', {}, { layout: { padding: { bottom: 20 } } }, '12 24 20 24'],
    ['layout', {}, { layout: { padding: { top: 12.25 } } }, '12.3 24 12 24'],
    ['fill', {}, {}, 'None'],
    ['fill', { backgroundColor: 'rgb(29, 78, 216)' }, {}, '#1D4ED8'],
    ['fill', { backgroundColor: 'rgba(29, 78, 216, 0.5)' }, {}, '#1D4ED8 50%'],
    ['fill', {}, { fill: { kind: 'token', name: 'brand' } }, 'brand'],
    ['fill', { backgroundColor: 'rgb(29, 78, 216)' }, { fill: { kind: 'none' } }, 'None'],
    ['stroke', {}, {}, 'None'],
    [
      'stroke',
      { borderTopWidth: '2px', borderTopStyle: 'dashed', borderTopColor: 'rgb(29, 78, 216)' },
      {},
      '2 dashed #1D4ED8',
    ],
    [
      'stroke',
      { borderTopWidth: '2px', borderTopStyle: 'solid' },
      { stroke: { kind: 'none' } },
      'None',
    ],
    ['text', {}, {}, '16 / 24 · Regular'],
    ['text', { lineHeight: 'normal' }, {}, '16 · Regular'],
    ['text', { fontWeight: '650' }, {}, '16 / 24 · 650'],
    ['text', {}, { text: { size: 18, weight: 700 } }, '18 / 24 · Bold'],
    ['effects', {}, {}, 'None'],
    ['effects', {}, { effects: { drop: { kind: 'token', name: 'sm' } } }, 'Drop shadow sm'],
    [
      'effects',
      {},
      {
        effects: {
          drop: { kind: 'token', name: 'sm' },
          inner: { kind: 'custom', x: 0, y: 2, blur: 4, spread: 0, hex: '#000000', opacity: 5 },
        },
      },
      'Drop shadow sm · Inner shadow',
    ],
    ['opacity', {}, {}, '100%'],
    ['opacity', { opacity: '0.5' }, {}, '50%'],
    ['opacity', { opacity: '0.5' }, { opacity: 80 }, '80%'],
  ] as const)('%s with %o and draft %o reads "%s"', (group, computed, draft, expected) => {
    expect(sectionSummary(group, style(), current(computed), draft)).toBe(expected);
  });

  it('names the theme token before the computed colour', () => {
    const tokens = style({
      tokens: [
        {
          token: 'bg-brand',
          group: 'fill',
          property: 'color',
          variants: [],
          editable: true,
          themeToken: 'brand',
          value: '#BE123C',
        },
      ],
    });

    expect(
      sectionSummary('fill', tokens, current({ backgroundColor: 'rgb(190, 18, 60)' }), {}),
    ).toBe('brand');
  });

  it('says nothing before the element is read', () => {
    for (const group of ['layout', 'fill', 'stroke', 'text', 'effects', 'opacity'] as const) {
      expect(sectionSummary(group, style(), null, {})).toBe('');
    }
  });
});

describe('remembered open sections', () => {
  it.each([
    [null, []],
    ['', []],
    ['not json', []],
    ['{"layout":true}', []],
    ['"layout"', []],
    ['["layout","text"]', ['layout', 'text']],
    ['["layout","layout","text"]', ['layout', 'text']],
    ['["layout","margin",3,null,{"group":"fill"}]', ['layout']],
  ])('%s opens %o', (stored, expected) => {
    expect(parseSections(stored)).toEqual(expected);
  });
});
