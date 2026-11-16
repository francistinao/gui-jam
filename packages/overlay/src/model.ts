import type { ElementStyle, StyleGroup, StyleToken } from '@guijam/contracts-ts';

export type { Tool } from './host';

export interface Range {
  min: number;
  max: number;
}

/** FR-062 ranges. */
export const RADIUS_RANGE: Range = { min: 0, max: 999 };
export const OPACITY_RANGE: Range = { min: 0, max: 100 };

/** Groups this build can edit directly; the rest are shown read-only. */
const WRITABLE: ReadonlySet<StyleGroup> = new Set<StyleGroup>(['radius', 'fill']);

/** Figma UI3 order: layout (radius) first, then fill, stroke, text, effects. */
const SECTION_ORDER: readonly StyleGroup[] = [
  'radius',
  'fill',
  'stroke',
  'text',
  'effects',
  'opacity',
];

const TEXTLESS_TAGS: ReadonlySet<string> = new Set([
  'img',
  'video',
  'canvas',
  'svg',
  'input',
  'hr',
  'br',
  'iframe',
  'picture',
]);

/** FR-061: six hex digits, with or without `#`, any case. Returns `#RRGGBB` or null. */
export function parseHex(input: string): string | null {
  const digits = input.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(digits) ? `#${digits.toUpperCase()}` : null;
}

export function clamp(value: number, range: Range): number {
  return Math.min(range.max, Math.max(range.min, value));
}

export interface HexColor {
  hex: string;
  /** 0–100. */
  opacity: number;
}

/** Converts a computed `rgb()`/`rgba()` colour to hex and percent opacity. */
export function hexOfComputedColor(css: string): HexColor | null {
  const match = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  if (!match?.[1]) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const [r, g, b, a = 1] = parts;
  if (r === undefined || g === undefined || b === undefined || parts.some(Number.isNaN)) {
    return null;
  }
  const hex = [r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0'));
  return { hex: `#${hex.join('').toUpperCase()}`, opacity: Math.round(a * 100) };
}

/** `rgba()` for an optimistic inline style. */
export function cssColor({ hex, opacity }: HexColor): string {
  const channel = (start: number) => Number.parseInt(hex.slice(start, start + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${opacity / 100})`;
}

/**
 * The colour a fill token writes, when the source states it as hex (a theme colour or
 * an arbitrary value). Inspect re-reads the source after Apply and Undo, so this stays
 * right while the page is still catching up; the computed style is the fallback.
 */
export function fillOfToken(token: StyleToken | undefined): HexColor | null {
  const hex = parseHex(token?.value ?? '');
  if (!token || !hex) return null;
  const modifier = /\/(\d{1,3})$/.exec(token.token)?.[1];
  return { hex, opacity: modifier === undefined ? 100 : clamp(Number(modifier), OPACITY_RANGE) };
}

/** The radius a token writes, when the source states it in px. */
export function radiusOfToken(token: StyleToken | undefined): number | null {
  const value = token?.value;
  if (!value?.endsWith('px')) return null;
  const px = Number.parseFloat(value);
  return Number.isFinite(px) ? px : null;
}

export type SectionMode = 'edit' | 'add' | 'readonly';

export interface PanelSection {
  group: StyleGroup;
  mode: SectionMode;
  tokens: StyleToken[];
}

/**
 * The adaptive panel: groups the element uses come first in UI3 order, editable when
 * this build can write them; writable groups it does not use are offered as "+" rows;
 * groups that do not apply to the element's kind are left out. A className computed
 * at runtime makes every section read-only.
 */
export function panelSections(style: ElementStyle): PanelSection[] {
  const dynamic = style.classSource === 'dynamic';
  return SECTION_ORDER.flatMap((group): PanelSection[] => {
    if (group === 'text' && TEXTLESS_TAGS.has(style.tag)) return [];
    const tokens = style.tokens.filter((token) => token.group === group);
    const writable = WRITABLE.has(group) && !dynamic;
    if (tokens.length === 0) return writable ? [{ group, mode: 'add', tokens }] : [];
    const editable = writable && tokens.some((token) => token.editable);
    return [{ group, mode: editable ? 'edit' : 'readonly', tokens }];
  });
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  side: 'right' | 'left' | 'below';
}

/** FR-031: beside the element (right, else left, else below), fully inside the viewport. */
export function placePopover(anchor: Rect, popover: Size, viewport: Size, gap = 12): Placement {
  const fitsTop = (top: number) =>
    Math.min(Math.max(top, gap), Math.max(gap, viewport.height - popover.height - gap));
  const right = anchor.left + anchor.width + gap;
  if (right + popover.width + gap <= viewport.width) {
    return { left: right, top: fitsTop(anchor.top), side: 'right' };
  }
  const left = anchor.left - gap - popover.width;
  if (left >= gap) return { left, top: fitsTop(anchor.top), side: 'left' };
  const below = Math.min(Math.max(anchor.left, gap), viewport.width - popover.width - gap);
  return {
    left: Math.max(gap, below),
    top: fitsTop(anchor.top + anchor.height + gap),
    side: 'below',
  };
}
