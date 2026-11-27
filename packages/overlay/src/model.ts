import type {
  EffectsValue,
  ElementStyle,
  FillValue,
  FinetuneProps,
  GapValue,
  GenerateDone,
  PaddingValue,
  RadiusValue,
  ShadowValue,
  StrokeValue,
  StyleGroup,
  StyleToken,
  TextPlace,
  TextValue,
} from '@guijam/contracts-ts';
import type { Tool } from './host';

export type { Tool } from './host';

export interface Range {
  min: number;
  max: number;
}

export const RADIUS_RANGE: Range = { min: 0, max: 999 };
export const OPACITY_RANGE: Range = { min: 0, max: 100 };

export const GROUP_LABELS: Record<StyleGroup, string> = {
  layout: 'Layout',
  radius: 'Radius',
  fill: 'Fill',
  stroke: 'Stroke',
  text: 'Text',
  effects: 'Effects',
  opacity: 'Opacity',
};

const ALWAYS_OPEN: ReadonlySet<StyleGroup> = new Set<StyleGroup>(['layout', 'text', 'opacity']);

export const SECTION_ORDER: readonly StyleGroup[] = [
  'layout',
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

export function parseHex(input: string): string | null {
  const digits = input.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(digits) ? `#${digits.toUpperCase()}` : null;
}

export function clamp(value: number, range: Range): number {
  return Math.min(range.max, Math.max(range.min, value));
}

export interface HexColor {
  hex: string;
  opacity: number;
}

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

export function cssColor({ hex, opacity }: HexColor): string {
  const channel = (start: number) => Number.parseInt(hex.slice(start, start + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${opacity / 100})`;
}

export function fillOfToken(token: StyleToken | undefined): HexColor | null {
  const hex = parseHex(token?.value ?? '');
  if (!token || !hex) return null;
  const modifier = /\/(\d{1,3})$/.exec(token.token)?.[1];
  return { hex, opacity: modifier === undefined ? 100 : clamp(Number(modifier), OPACITY_RANGE) };
}

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

export function panelSections(style: ElementStyle): PanelSection[] {
  const dynamic =
    style.adapter === 'vuetify'
      ? false
      : style.adapter === 'inline'
        ? style.styleSource === 'dynamic'
        : style.classSource === 'dynamic';
  return SECTION_ORDER.flatMap((group): PanelSection[] => {
    if (group === 'text' && TEXTLESS_TAGS.has(style.tag)) return [];
    const tokens = style.tokens.filter((token) => token.group === group);
    if (dynamic) return tokens.length === 0 ? [] : [{ group, mode: 'readonly', tokens }];
    if (ALWAYS_OPEN.has(group)) return [{ group, mode: 'edit', tokens }];
    if (tokens.length === 0) return [{ group, mode: 'add', tokens }];
    return [{ group, mode: tokens.some((token) => token.editable) ? 'edit' : 'readonly', tokens }];
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
  side: 'right' | 'left' | 'below' | 'above' | 'corner';
}

export function placePopover(anchor: Rect, popover: Size, viewport: Size, gap = 12): Placement {
  const maxLeft = Math.max(gap, viewport.width - popover.width - gap);
  const maxTop = Math.max(gap, viewport.height - popover.height - gap);
  const clampLeft = (left: number) => Math.min(Math.max(left, gap), maxLeft);
  const clampTop = (top: number) => Math.min(Math.max(top, gap), maxTop);
  const cover = (placement: Placement) =>
    overlap({ left: placement.left, top: placement.top, ...popover }, anchor);
  const inside = (placement: Placement) =>
    placement.left >= gap &&
    placement.top >= gap &&
    placement.left <= maxLeft &&
    placement.top <= maxTop;
  const free = (placement: Placement) => inside(placement) && cover(placement) === 0;
  const onScreen = (placement: Placement): Placement => ({
    ...placement,
    left: clampLeft(placement.left),
    top: clampTop(placement.top),
  });
  const toRight: Placement = {
    left: anchor.left + anchor.width + gap,
    top: clampTop(anchor.top),
    side: 'right',
  };
  const toLeft: Placement = {
    left: anchor.left - gap - popover.width,
    top: clampTop(anchor.top),
    side: 'left',
  };
  const toBelow: Placement = {
    left: clampLeft(anchor.left),
    top: anchor.top + anchor.height + gap,
    side: 'below',
  };
  const toAbove: Placement = {
    left: clampLeft(anchor.left),
    top: anchor.top - gap - popover.height,
    side: 'above',
  };
  const corners: Placement[] = [
    { left: maxLeft, top: gap, side: 'corner' },
    { left: gap, top: gap, side: 'corner' },
    { left: gap, top: maxTop, side: 'corner' },
  ];
  const found = [toRight, toLeft, toBelow, toAbove, ...corners].find(free);
  if (found) return found;
  const below = onScreen(toBelow);
  const above = onScreen(toAbove);
  return cover(above) < cover(below) ? above : below;
}

const BADGE_EDGE = 12;
const BADGE_GAP = 4;
const BADGE_HEIGHT = 24;
const BADGE_ROOM = 96;

export interface BadgeSpot {
  right: number;
  top: number;
  side: 'above' | 'below' | 'inside';
}

export function badgeSpot(anchor: Rect, viewport: Size): BadgeSpot {
  const right = Math.min(
    Math.max(anchor.left + anchor.width, BADGE_EDGE + BADGE_ROOM),
    viewport.width - BADGE_EDGE,
  );
  const above = anchor.top - BADGE_GAP - BADGE_HEIGHT;
  if (above >= BADGE_EDGE) return { right, top: above, side: 'above' };
  const below = anchor.top + anchor.height + BADGE_GAP;
  if (below + BADGE_HEIGHT <= viewport.height - BADGE_EDGE) {
    return { right, top: below, side: 'below' };
  }
  const top = Math.min(
    Math.max(anchor.top, BADGE_EDGE),
    viewport.height - BADGE_EDGE - BADGE_HEIGHT,
  );
  return { right, top, side: 'inside' };
}

export interface Point {
  x: number;
  y: number;
}

export interface PanelSpot {
  left: number;
  top: number;
}

export const PANEL_EDGE = 12;
export const DRAG_THRESHOLD = 3;
const NUDGE = 10;
const BIG_NUDGE = 50;

export function clampPanel(
  spot: PanelSpot,
  panel: Size,
  viewport: Size,
  edge = PANEL_EDGE,
): PanelSpot {
  const maxLeft = Math.max(edge, viewport.width - panel.width - edge);
  const maxTop = Math.max(edge, viewport.height - panel.height - edge);
  return {
    left: Math.round(Math.min(Math.max(spot.left, edge), maxLeft)),
    top: Math.round(Math.min(Math.max(spot.top, edge), maxTop)),
  };
}

export const PANEL_MIN_ROOM = 240;

export interface HeldPanel extends PanelSpot {
  maxHeight: number;
}

export function placeHeldPanel(spot: PanelSpot, panel: Size, viewport: Size): HeldPanel {
  const room = { width: panel.width, height: Math.min(panel.height, PANEL_MIN_ROOM) };
  const placed = clampPanel(spot, room, viewport);
  return { ...placed, maxHeight: Math.max(0, viewport.height - placed.top - PANEL_EDGE) };
}

export function pastDragThreshold(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;
}

export function nudgePanel(spot: PanelSpot, key: string, big: boolean): PanelSpot | 'reset' | null {
  const step = big ? BIG_NUDGE : NUDGE;
  switch (key) {
    case 'ArrowLeft':
      return { left: spot.left - step, top: spot.top };
    case 'ArrowRight':
      return { left: spot.left + step, top: spot.top };
    case 'ArrowUp':
      return { left: spot.left, top: spot.top - step };
    case 'ArrowDown':
      return { left: spot.left, top: spot.top + step };
    case 'Home':
      return 'reset';
    default:
      return null;
  }
}

export function isPanelSpot(value: unknown): value is PanelSpot {
  if (typeof value !== 'object' || value === null) return false;
  const { left, top } = value as Record<string, unknown>;
  return (
    typeof left === 'number' &&
    typeof top === 'number' &&
    Number.isFinite(left) &&
    Number.isFinite(top)
  );
}

export interface SketchToggleOwner {
  strokes: readonly unknown[];
  generation: {
    status: 'idle' | 'running' | 'ready';
    variants: readonly unknown[];
  };
}

export function showsSketchToggle({ strokes, generation }: SketchToggleOwner): boolean {
  return strokes.length > 0 && generation.status !== 'idle' && generation.variants.length > 0;
}

export function boundsOf(points: readonly Point[]): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export function samplePoints({ left, top, width, height }: Rect): Point[] {
  const x = left + width / 2;
  const y = top + height / 2;
  return [
    { x, y },
    { x: x - width / 4, y },
    { x: x + width / 4, y },
    { x, y: y - height / 4 },
    { x, y: y + height / 4 },
  ];
}

const area = (rect: Rect) => Math.max(0, rect.width) * Math.max(0, rect.height);

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

const DRAW_COVERAGE = 0.6;

export function chooseDrawTarget(stroke: Rect, candidates: readonly Rect[]): number | null {
  const strokeArea = Math.max(area(stroke), 1);
  let enclosed: number | null = null;
  let covering: number | null = null;
  candidates.forEach((rect, index) => {
    const size = area(rect);
    if (size === 0) return;
    const shared = overlap(stroke, rect);
    if (shared / size >= DRAW_COVERAGE) {
      const best = enclosed === null ? undefined : candidates[enclosed];
      if (!best || size > area(best)) enclosed = index;
    }
    const covers =
      area(stroke) === 0 ? isInside(stroke, rect) : shared / strokeArea >= DRAW_COVERAGE;
    if (covers) {
      const best = covering === null ? undefined : candidates[covering];
      if (!best || size < area(best)) covering = index;
    }
  });
  return enclosed ?? covering;
}

function isInside(point: Rect, rect: Rect): boolean {
  return (
    point.left >= rect.left &&
    point.left <= rect.left + rect.width &&
    point.top >= rect.top &&
    point.top <= rect.top + rect.height
  );
}

export function droppedNote(dropped: GenerateDone['dropped']): string | null {
  const [first] = dropped;
  if (!first) return null;
  const count = dropped.length === 1 ? '1 variant was' : `${dropped.length} variants were`;
  return `${count} dropped: ${first.reason}`;
}

export type AnswerPart = { at: number; text: string } | { at: number; path: string };

const PROJECT_PATH =
  /(?:[\w@.-]+\/)+[\w.-]+\.(?:tsx|ts|jsx|js|mjs|css|scss|html|json|svg|png|jpe?g|gif|webp|avif|ico)(?::\d+(?::\d+)?)?/g;

export function splitPaths(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const match of answer.matchAll(PROJECT_PATH)) {
    if (match.index > last) parts.push({ at: last, text: answer.slice(last, match.index) });
    parts.push({ at: match.index, path: match[0] });
    last = match.index + match[0].length;
  }
  if (last < answer.length) parts.push({ at: last, text: answer.slice(last) });
  return parts;
}

export type Gesture = { kind: 'select'; index: number } | { kind: 'sketch' };

const TAP_SIZE = 6;
const CLOSED_LOOP = 0.25;
const LOOP_FILL = 0.25;
const EDGE_SLACK = 2;

function enclosedTarget(loop: Rect, candidates: readonly Rect[]): number | null {
  const loopArea = Math.max(area(loop), 1);
  let best: number | null = null;
  candidates.forEach((rect, index) => {
    const size = area(rect);
    if (size === 0 || overlap(loop, rect) / size < DRAW_COVERAGE || size / loopArea < LOOP_FILL) {
      return;
    }
    const current = best === null ? undefined : candidates[best];
    if (!current || size > area(current)) best = index;
  });
  return best;
}

export function classifyGesture(points: readonly Point[], candidates: readonly Rect[]): Gesture {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return { kind: 'sketch' };
  const bounds = boundsOf(points);
  if (bounds.width <= TAP_SIZE && bounds.height <= TAP_SIZE) {
    const index = chooseDrawTarget(
      { left: first.x, top: first.y, width: 0, height: 0 },
      candidates,
    );
    return index === null ? { kind: 'sketch' } : { kind: 'select', index };
  }
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  if (gap > Math.hypot(bounds.width, bounds.height) * CLOSED_LOOP) return { kind: 'sketch' };
  const index = enclosedTarget(bounds, candidates);
  return index === null ? { kind: 'sketch' } : { kind: 'select', index };
}

export function containerIndex(bounds: Rect, candidates: readonly Rect[]): number | null {
  let best: number | null = null;
  candidates.forEach((rect, index) => {
    const contains =
      rect.left <= bounds.left + EDGE_SLACK &&
      rect.top <= bounds.top + EDGE_SLACK &&
      rect.left + rect.width >= bounds.left + bounds.width - EDGE_SLACK &&
      rect.top + rect.height >= bounds.top + bounds.height - EDGE_SLACK;
    if (!contains || area(rect) === 0) return;
    const current = best === null ? undefined : candidates[best];
    if (!current || area(rect) < area(current)) best = index;
  });
  return best;
}

export function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return overlap(a, b) > 0;
}

export interface SketchState {
  strokes: Point[][];
  undone: Point[][];
  bounds: Rect;
  element?: Rect;
}

export function sketchOver(element: Rect): SketchState {
  return { strokes: [], undone: [], bounds: element, element };
}

export function addStroke(sketch: SketchState, stroke: Point[], bounds: Rect): SketchState {
  return {
    ...sketch,
    strokes: [...sketch.strokes, stroke],
    undone: [],
    bounds: sketch.strokes.length === 0 ? bounds : unionRect(sketch.bounds, bounds),
  };
}

function withStrokes(sketch: SketchState, strokes: Point[][], undone: Point[][]): SketchState {
  const [first, ...rest] = strokes;
  const bounds = first
    ? rest.reduce((all, stroke) => unionRect(all, boundsOf(stroke)), boundsOf(first))
    : (sketch.element ?? sketch.bounds);
  return { ...sketch, strokes, undone, bounds };
}

export function undoStroke(sketch: SketchState): SketchState {
  const last = sketch.strokes.at(-1);
  if (!last) return sketch;
  return withStrokes(sketch, sketch.strokes.slice(0, -1), [...sketch.undone, last]);
}

export function redoStroke(sketch: SketchState): SketchState {
  const next = sketch.undone.at(-1);
  if (!next) return sketch;
  return withStrokes(sketch, [...sketch.strokes, next], sketch.undone.slice(0, -1));
}

const IME_KEY_CODE = 229;

export interface ShortcutKeys {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface EscapeKey {
  key: string;
  isComposing: boolean;
  keyCode: number;
}

export function closesOnEscape(event: EscapeKey): boolean {
  return event.key === 'Escape' && !event.isComposing && event.keyCode !== IME_KEY_CODE;
}

export function strokeShortcut(keys: ShortcutKeys): 'undo' | 'redo' | null {
  if (!(keys.ctrlKey || keys.metaKey) || keys.altKey) return null;
  const key = keys.key.toLowerCase();
  if (key === 'z') return keys.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !keys.shiftKey) return 'redo';
  return null;
}

export function sketchAnchor(sketch: SketchState): Rect {
  const { element, strokes, bounds } = sketch;
  if (!element) return bounds;
  return strokes.length === 0 ? element : unionRect(element, bounds);
}

export interface SketchOwner {
  sketch: SketchState | null;
  generation: { status: 'idle' | 'running' | 'ready' };
}

export function sketchingOver(mode: 'finetune' | 'prompt', job: SketchOwner | undefined): boolean {
  return (
    mode === 'prompt' && job?.sketch?.element !== undefined && job.generation.status === 'idle'
  );
}

export interface Layers {
  select: boolean;
  draw: boolean;
}

export function activeLayers(tool: Tool | null, sketching: boolean): Layers {
  return {
    select: tool === 'select' && !sketching,
    draw: tool === 'draw' || sketching,
  };
}

const CLOSE_UP_PADDING = 24;
const CLOSE_UP_MAX_COVER = 0.9;

export function closeUpRect(focus: Rect, viewport: Size, padding = CLOSE_UP_PADDING): Rect | null {
  const left = Math.max(0, Math.floor(focus.left - padding));
  const top = Math.max(0, Math.floor(focus.top - padding));
  const right = Math.min(viewport.width, Math.ceil(focus.left + focus.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(focus.top + focus.height + padding));
  if (right <= left || bottom <= top) return null;
  const rect = { left, top, width: right - left, height: bottom - top };
  return area(rect) >= viewport.width * viewport.height * CLOSE_UP_MAX_COVER ? null : rect;
}

export function shiftedLine(
  line: number,
  changes: readonly { line: number; before: readonly string[]; after: readonly string[] }[],
): number {
  return changes
    .filter((change) => change.line + change.before.length <= line)
    .reduce((shifted, change) => shifted + change.after.length - change.before.length, line);
}

export function changesIn<T extends { file: string }>(file: string, changes: readonly T[]): T[] {
  const slashed = (path: string) => path.replaceAll('\\', '/');
  return changes.filter((change) => slashed(change.file) === slashed(file));
}

export function invertChanges<
  T extends { line: number; before: readonly string[]; after: readonly string[] },
>(changes: readonly T[]): { line: number; before: readonly string[]; after: readonly string[] }[] {
  let offset = 0;
  return [...changes]
    .sort((a, b) => a.line - b.line)
    .map((change) => {
      const inverted = { line: change.line + offset, before: change.after, after: change.before };
      offset += change.after.length - change.before.length;
      return inverted;
    });
}

export const MAX_JOBS = 3;

export const MAX_TARGETS = 5;

export type Regrouped<T> = { targets: readonly T[] } | { full: true };

export function toggleTarget<T extends { src: string }>(
  targets: readonly T[],
  picked: T,
  max = MAX_TARGETS,
): Regrouped<T> {
  if (targets.some((target) => target.src === picked.src)) {
    if (targets.length === 1) return { targets };
    return { targets: targets.filter((target) => target.src !== picked.src) };
  }
  if (targets.length >= max) return { full: true };
  return { targets: [...targets, picked] };
}

export function nextJobNumber(taken: readonly number[]): number {
  let number = 1;
  while (taken.includes(number)) number += 1;
  return number;
}

export type BadgeState = 'draft' | 'running' | 'ready' | 'answer' | 'error';

export interface BadgeInput {
  status: 'idle' | 'running' | 'ready';
  variants: number;
  answered: boolean;
  failed: boolean;
}

export function jobBadge({ status, variants, answered, failed }: BadgeInput): {
  state: BadgeState;
  text: string;
} {
  if (status === 'running') return { state: 'running', text: 'Generating' };
  if (status === 'ready' && answered) return { state: 'answer', text: 'Answer' };
  if (status === 'ready') {
    return { state: 'ready', text: variants === 1 ? '1 variant' : `${variants} variants` };
  }
  if (failed) return { state: 'error', text: 'Failed' };
  return { state: 'draft', text: 'Draft' };
}

export function pagePath(page: string): string {
  const url = new URL(page);
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface SrcAt {
  src: string;
  file: string;
}

export function placedCopy(
  inside: readonly SrcAt[],
  ancestor: SrcAt | undefined,
): string | undefined {
  const sameAsAncestor = ancestor
    ? inside.find((entry) => entry.file === ancestor.file)
    : undefined;
  return (sameAsAncestor ?? inside[0] ?? ancestor)?.src;
}

export interface WorkContext {
  sketch: boolean;
  images: number;
  links: number;
  expectedMs: number | null;
}

export const STILL_WORKING_MS = 15_000;
export const SLOW_MS = 45_000;
export const VERY_SLOW_MS = 90_000;

function reason({ sketch, images, links }: WorkContext): string {
  if (images > 0) {
    return `Still working: matching the look of your ${images === 1 ? 'image' : `${images} images`}.`;
  }
  if (links > 0) {
    return `Still working: using what it read from ${links === 1 ? 'your link' : `${links} links`}.`;
  }
  if (sketch) return 'Still working on your sketch: laying out the parts and their styles.';
  return 'Still working: the model is writing three takes on your request.';
}

export function stillWorking(
  elapsedMs: number,
  timeoutMs: number | null,
  context: WorkContext,
): string {
  if (elapsedMs < STILL_WORKING_MS) return 'Generating…';
  const { expectedMs } = context;
  const slow = Math.max(SLOW_MS, (expectedMs ?? 0) * 1.25);
  const verySlow = Math.max(VERY_SLOW_MS, (expectedMs ?? 0) * 2);
  if (elapsedMs < slow) {
    if (expectedMs !== null) {
      const seconds = Math.max(1, Math.round(expectedMs / 1000));
      return `Still generating. With this AI tool and model the first variant usually takes about ${seconds} s.`;
    }
    return context.sketch || context.images > 0
      ? 'Still generating. Sketches and new components usually take 20 to 60 s.'
      : 'Still generating. Most changes take 10 to 40 s.';
  }
  if (elapsedMs < verySlow) return reason(context);
  if (timeoutMs === null)
    return 'Taking longer than usual. You can keep waiting or Cancel any time.';
  const limit = Math.round(timeoutMs / 1000);
  return `Taking longer than usual. It stops on its own after ${limit} s, or Cancel any time.`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export const MAX_LINKS = 3;
const TRAILING = /[.,;:!?'"`*]+$/;
const LEADING = /^[([<"'`]+/;
const PAIRS: readonly (readonly [string, string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
];
const LABEL_CHARS = 40;

export interface PromptLink {
  href: string;
  label: string;
}

export interface PromptLinks {
  links: PromptLink[];
  skipped: number;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

function trimTrailing(text: string): string {
  let current = text;
  for (;;) {
    let next = current.replace(TRAILING, '');
    for (const [open, close] of PAIRS) {
      if (next.endsWith(close) && count(next, close) > count(next, open)) next = next.slice(0, -1);
    }
    if (next === current) return next;
    current = next;
  }
}

function candidate(token: string): string | null {
  const starts = [token.indexOf('https://'), token.indexOf('http://')].filter((at) => at >= 0);
  if (starts.length > 0) return trimTrailing(token.slice(Math.min(...starts)));
  const bare = trimTrailing(token.replace(LEADING, ''));
  return bare.length > 4 && bare.slice(0, 4).toLowerCase() === 'www.' ? `https://${bare}` : null;
}

function linkLabel(url: URL): string {
  const host = url.host.replace(/^www\./, '');
  const full = `${host}${url.pathname.replace(/\/+$/, '')}`;
  return full.length > LABEL_CHARS ? `${full.slice(0, LABEL_CHARS - 1)}…` : full;
}

export function linksIn(prompt: string): PromptLinks {
  const links: PromptLink[] = [];
  for (const token of prompt.split(/\s+/)) {
    const text = candidate(token);
    if (!text || !URL.canParse(text)) continue;
    const url = new URL(text);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) continue;
    if (url.hostname === 'www.') continue;
    url.hash = '';
    if (!links.some((link) => link.href === url.href)) {
      links.push({ href: url.href, label: linkLabel(url) });
    }
  }
  return { links: links.slice(0, MAX_LINKS), skipped: Math.max(0, links.length - MAX_LINKS) };
}

export interface Needs {
  command: string;
  packages: readonly { name: string; version: string }[];
}

export function withoutInstalled<T extends { needs?: Needs }>(
  variant: T,
  installed: ReadonlySet<string>,
): T {
  if (!variant.needs) return variant;
  const { needs, ...rest } = variant;
  const packages = needs.packages.filter((entry) => !installed.has(entry.name));
  return (packages.length === 0 ? rest : { ...rest, needs: { ...needs, packages } }) as T;
}

export function needsLine(needs: Needs): string {
  const names = needs.packages.map((entry) => `${entry.name} ${entry.version}`).join(', ');
  const pronoun = needs.packages.length === 1 ? 'it' : 'them';
  return `Needs ${names}. It isn't previewed until you install ${pronoun}.`;
}

export function editedFiles(variant: {
  file: string;
  changes: readonly { file: string }[];
  created: readonly string[];
}): string[] {
  const slashed = (path: string) => path.replaceAll('\\', '/');
  const created = new Set(variant.created.map(slashed));
  const files = [...new Set(variant.changes.map((change) => slashed(change.file)))].filter(
    (file) => !created.has(file),
  );
  return files.length > 0 ? files : [slashed(variant.file)];
}

export function appliedMessage(files: readonly string[]): string {
  const names = files.map((file) => file.split(/[\\/]/).pop() ?? file);
  const [first = '', second = ''] = names;
  if (names.length <= 1) return `Applied to ${first}.`;
  if (names.length === 2) return `Applied to ${first} and ${second}.`;
  return `Applied to ${first} and ${names.length - 1} other files.`;
}

export function nearestIndex(bounds: Rect, candidates: readonly Rect[]): number | null {
  let best: number | null = null;
  let bestAcross = false;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const [index, rect] of candidates.entries()) {
    const across =
      Math.min(rect.left + rect.width, bounds.left + bounds.width) -
        Math.max(rect.left, bounds.left) >
      0;
    const gap = Math.max(
      0,
      rect.top - (bounds.top + bounds.height),
      bounds.top - (rect.top + rect.height),
    );
    if ((across && !bestAcross) || (across === bestAcross && gap < bestGap)) {
      best = index;
      bestAcross = across;
      bestGap = gap;
    }
  }
  return best;
}

export function followedSrc(
  selection: { file: string; line: number; column: number },
  changes: readonly {
    file: string;
    line: number;
    before: readonly string[];
    after: readonly string[];
  }[],
): { src: string; touched: boolean } {
  const own = changesIn(selection.file, changes);
  const touched = own.some(
    (change) =>
      change.line <= selection.line &&
      selection.line < change.line + Math.max(change.before.length, 1),
  );
  const line = shiftedLine(selection.line, own);
  return { src: `${selection.file}:${line}:${selection.column}`, touched };
}

export type StyleDraft = Pick<
  FinetuneProps,
  'fill' | 'radius' | 'text' | 'stroke' | 'effects' | 'opacity' | 'layout'
>;

export interface Draft extends StyleDraft {
  content?: Record<number, string>;
  source?: { place: TextPlace; value: string };
}

const MAX_SHOWN_TEXT = 500;

export function shownText(text: string | null): string | undefined {
  const collapsed = (text ?? '').split(/\s+/).filter(Boolean).join(' ');
  return collapsed ? [...collapsed].slice(0, MAX_SHOWN_TEXT).join('') : undefined;
}

export function finetuneProps({ content, source, ...groups }: Draft): FinetuneProps {
  const [first, ...rest] = Object.entries(content ?? {})
    .map(([run, value]) => ({ run: Number(run), value }))
    .sort((a, b) => a.run - b.run);
  const set = Object.fromEntries(
    Object.entries(groups).filter(([, value]) => value !== undefined),
  ) as StyleDraft;
  return {
    ...set,
    ...(first ? { content: [first, ...rest] } : {}),
    ...(source
      ? {
          source: {
            file: source.place.file,
            line: source.place.line,
            column: source.place.column,
            value: source.value,
          },
        }
      : {}),
  };
}

export function keyedParts<T>(parts: readonly T[]): { key: string; part: T }[] {
  const seen = new Map<string, number>();
  const keyed: { key: string; part: T }[] = [];
  for (const part of parts) {
    const base = JSON.stringify(part);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    keyed.push({ key: `${base}#${count}`, part });
  }
  return keyed;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type Flow = 'row' | 'column' | 'grid';

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  hex: string;
  opacity: number;
}

export interface Current {
  fill: HexColor | null;
  radiusPx: number | null;
  color: HexColor | null;
  fontSize: number | null;
  fontWeight: number | null;
  lineHeight: number | null;
  letterSpacing: number;
  align: TextAlign;
  border: { width: number; style: string; color: HexColor | null };
  shadows: { drop: Shadow | null; inner: Shadow | null };
  opacity: number;
  padding: Record<Side, number>;
  gap: { row: number; column: number };
  flow: Flow | null;
}

export type ComputedLike = Pick<
  CSSStyleDeclaration,
  | 'backgroundColor'
  | 'borderTopLeftRadius'
  | 'color'
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'letterSpacing'
  | 'textAlign'
  | 'borderTopWidth'
  | 'borderTopStyle'
  | 'borderTopColor'
  | 'boxShadow'
  | 'opacity'
  | 'paddingTop'
  | 'paddingRight'
  | 'paddingBottom'
  | 'paddingLeft'
  | 'rowGap'
  | 'columnGap'
  | 'display'
  | 'flexDirection'
>;

function pixels(css: string): number | null {
  const value = Number.parseFloat(css);
  return Number.isFinite(value) ? value : null;
}

function rounded(value: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function topLevel(css: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const char of css) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && (separator === ' ' ? /\s/.test(char) : char === separator)) {
      if (part.trim()) parts.push(part.trim());
      part = '';
    } else part += char;
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
}

function colorOf(word: string): HexColor | null {
  const hex = parseHex(word);
  if (hex && word.trim().startsWith('#')) return { hex, opacity: 100 };
  return hexOfComputedColor(word);
}

export function parseShadows(css: string): Current['shadows'] {
  const shadows: Current['shadows'] = { drop: null, inner: null };
  if (!css || css === 'none') return shadows;
  for (const layer of topLevel(css, ',')) {
    const words = topLevel(layer, ' ');
    const inset = words.includes('inset');
    const color = words.map(colorOf).find((found) => found !== null) ?? {
      hex: '#000000',
      opacity: 100,
    };
    const lengths = words
      .filter((word) => /^-?[\d.]+(px)?$/.test(word))
      .map((word) => Number.parseFloat(word));
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    if (color.opacity === 0 || (x === 0 && y === 0 && blur === 0)) continue;
    const shadow = { x, y, blur, spread, ...color };
    if (inset) shadows.inner ??= shadow;
    else shadows.drop ??= shadow;
  }
  return shadows;
}

export function currentOf(computed: ComputedLike): Current {
  const fontSize = pixels(computed.fontSize);
  const spacing = pixels(computed.letterSpacing);
  const align = computed.textAlign;
  const flow: Flow | null =
    computed.display === 'grid' || computed.display === 'inline-grid'
      ? 'grid'
      : computed.display === 'flex' || computed.display === 'inline-flex'
        ? computed.flexDirection.startsWith('column')
          ? 'column'
          : 'row'
        : null;
  return {
    fill: hexOfComputedColor(computed.backgroundColor),
    radiusPx: pixels(computed.borderTopLeftRadius),
    color: hexOfComputedColor(computed.color),
    fontSize,
    fontWeight: pixels(computed.fontWeight),
    lineHeight: pixels(computed.lineHeight),
    letterSpacing: spacing && fontSize ? rounded(spacing / fontSize, 3) : 0,
    align:
      align === 'center' || align === 'justify'
        ? align
        : align === 'right' || align === 'end'
          ? 'right'
          : 'left',
    border: {
      width: pixels(computed.borderTopWidth) ?? 0,
      style: computed.borderTopStyle,
      color: hexOfComputedColor(computed.borderTopColor),
    },
    shadows: parseShadows(computed.boxShadow),
    opacity: Math.round((pixels(computed.opacity) ?? 1) * 100),
    padding: {
      top: pixels(computed.paddingTop) ?? 0,
      right: pixels(computed.paddingRight) ?? 0,
      bottom: pixels(computed.paddingBottom) ?? 0,
      left: pixels(computed.paddingLeft) ?? 0,
    },
    gap: { row: pixels(computed.rowGap) ?? 0, column: pixels(computed.columnGap) ?? 0 },
    flow,
  };
}

function fillCss(fill: FillValue, style: ElementStyle | null): string | null {
  switch (fill.kind) {
    case 'hex':
      return cssColor({ hex: fill.hex, opacity: fill.opacity });
    case 'token':
      return style?.theme.colors.find((color) => color.name === fill.name)?.value ?? null;
    case 'none':
      return 'transparent';
  }
}

function radiusCss(radius: RadiusValue, style: ElementStyle | null): string | null {
  switch (radius.kind) {
    case 'px':
      return `${radius.px}px`;
    case 'full':
      return '9999px';
    case 'token': {
      const px = style?.theme.radii.find((entry) => entry.name === radius.name)?.px;
      return px === undefined ? null : `${px}px`;
    }
  }
}

export function shadowCss(shadow: ShadowValue, inset: boolean, style: ElementStyle | null): string {
  if (shadow.kind === 'token') {
    return (
      style?.theme.shadows.find((entry) => entry.name === shadow.name && entry.inset === inset)
        ?.value ?? 'none'
    );
  }
  const color = cssColor({ hex: shadow.hex, opacity: shadow.opacity });
  const css = `${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.spread}px ${color}`;
  return inset ? `inset ${css}` : css;
}

export function optimisticCss(draft: Draft, style: ElementStyle | null): Record<string, string> {
  const css: Record<string, string> = {};
  const put = (property: string, value: string | null) => {
    if (value !== null) css[property] = value;
  };
  if (draft.fill) put('background-color', fillCss(draft.fill, style));
  if (draft.radius) put('border-radius', radiusCss(draft.radius, style));
  const { text, stroke, effects, layout } = draft;
  if (text) {
    if (text.family) put('font-family', `var(--font-${text.family})`);
    if (text.weight !== undefined) put('font-weight', String(text.weight));
    if (text.size !== undefined) put('font-size', `${text.size}px`);
    if (text.lineHeight !== undefined) put('line-height', `${text.lineHeight}px`);
    if (text.letterSpacing !== undefined) put('letter-spacing', `${text.letterSpacing}em`);
    if (text.align) put('text-align', text.align);
    if (text.color) put('color', fillCss(text.color, style));
  }
  if (stroke?.kind === 'none') put('border-style', 'none');
  if (stroke?.kind === 'set') {
    if (stroke.width !== undefined) {
      put('border-width', `${stroke.width}px`);
      if (!stroke.style) put('border-style', 'solid');
    }
    if (stroke.style) put('border-style', stroke.style);
    if (stroke.color) put('border-color', fillCss(stroke.color, style));
  }
  if (effects) {
    const layers = [
      effects.drop ? shadowCss(effects.drop, false, style) : null,
      effects.inner ? shadowCss(effects.inner, true, style) : null,
    ].filter((layer): layer is string => layer !== null && layer !== 'none');
    put('box-shadow', layers.length > 0 ? layers.join(', ') : 'none');
  }
  if (draft.opacity !== undefined) put('opacity', String(draft.opacity / 100));
  for (const side of SIDES) {
    const value = layout?.padding?.[side];
    if (value !== undefined) put(`padding-${side}`, `${value}px`);
  }
  if (layout?.gap?.row !== undefined) put('row-gap', `${layout.gap.row}px`);
  if (layout?.gap?.column !== undefined) put('column-gap', `${layout.gap.column}px`);
  return css;
}

function trimmed(value: number): string {
  return String(rounded(value, 3));
}

export function spacingToken(prefix: string, px: number, step: number): string {
  if (px === 0) return `${prefix}-0`;
  if (px === 1) return `${prefix}-px`;
  const steps = px / step;
  return Number.isInteger(rounded(steps * 2, 3))
    ? `${prefix}-${trimmed(steps)}`
    : `${prefix}-[${trimmed(px)}px]`;
}

const SIDE_PREFIX: Record<Side, string> = { top: 'pt', right: 'pr', bottom: 'pb', left: 'pl' };

export function spacingLabel(
  px: number,
  target: Side | 'row' | 'column',
  style: ElementStyle,
): string {
  if (style.adapter !== 'tailwind') return `${trimmed(px)}px`;
  const prefix = target === 'row' ? 'gap-y' : target === 'column' ? 'gap-x' : SIDE_PREFIX[target];
  return `${trimmed(px)} · ${spacingToken(prefix, px, style.theme.spacing || 4)}`;
}

export const SPACING_RANGE: Range = { min: 0, max: 999 };

export function snapSpacing(raw: number, step: number, fine: boolean): number {
  const snapped = fine || step <= 0 ? Math.round(raw) : Math.round(raw / step) * step;
  return clamp(snapped, SPACING_RANGE);
}

export function draggedSpacing(
  start: number,
  side: Side | 'row' | 'column',
  delta: { x: number; y: number },
  step: number,
  fine: boolean,
): number {
  const moved =
    side === 'top' || side === 'row'
      ? delta.y
      : side === 'bottom'
        ? -delta.y
        : side === 'left' || side === 'column'
          ? delta.x
          : -delta.x;
  return snapSpacing(start + moved, step, fine);
}

export const OPPOSITE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

export function paddingBands(box: Rect, padding: Record<Side, number>): Record<Side, Rect> {
  return {
    top: { left: box.left, top: box.top, width: box.width, height: padding.top },
    bottom: {
      left: box.left,
      top: box.top + box.height - padding.bottom,
      width: box.width,
      height: padding.bottom,
    },
    left: { left: box.left, top: box.top, width: padding.left, height: box.height },
    right: {
      left: box.left + box.width - padding.right,
      top: box.top,
      width: padding.right,
      height: box.height,
    },
  };
}

export interface GapSlot {
  axis: 'row' | 'column';
  rect: Rect;
}

export function gapSlots(children: readonly Rect[]): GapSlot[] {
  const slots: GapSlot[] = [];
  for (let index = 1; index < children.length; index += 1) {
    const before = children[index - 1];
    const after = children[index];
    if (!before || !after) continue;
    const top = Math.max(before.top, after.top);
    const bottom = Math.min(before.top + before.height, after.top + after.height);
    if (after.left >= before.left + before.width - 1 && bottom > top) {
      slots.push({
        axis: 'column',
        rect: {
          left: before.left + before.width,
          top,
          width: after.left - (before.left + before.width),
          height: bottom - top,
        },
      });
    } else if (after.top >= before.top + before.height - 1) {
      const start = Math.min(before.left, after.left);
      const end = Math.max(before.left + before.width, after.left + after.width);
      slots.push({
        axis: 'row',
        rect: {
          left: start,
          top: before.top + before.height,
          width: end - start,
          height: after.top - (before.top + before.height),
        },
      });
    }
  }
  return slots;
}

function shadowFrom(token: StyleToken | undefined, inset: boolean): ShadowValue | undefined {
  if (!token) return undefined;
  if (token.themeToken && token.themeToken !== 'none') {
    return { kind: 'token', name: token.themeToken };
  }
  const parsed = parseShadows(`${inset ? 'inset ' : ''}${token.value ?? ''}`);
  const shadow = inset ? parsed.inner : parsed.drop;
  return shadow ? { kind: 'custom', ...shadow } : undefined;
}

function baseToken(
  style: ElementStyle,
  group: StyleGroup,
  property: string,
): StyleToken | undefined {
  return style.tokens.find(
    (token) => token.group === group && token.property === property && token.editable,
  );
}

export function effectsBase(style: ElementStyle, current: Current | null): EffectsValue {
  const drop = baseToken(style, 'effects', 'shadow');
  const inner = baseToken(style, 'effects', 'inset-shadow');
  const base: EffectsValue = {};
  const fromDrop = shadowFrom(drop, false);
  const fromInner = shadowFrom(inner, true);
  if (fromDrop) base.drop = fromDrop;
  else if (!drop && current?.shadows.drop) base.drop = { kind: 'custom', ...current.shadows.drop };
  if (fromInner) base.inner = fromInner;
  else if (!inner && current?.shadows.inner) {
    base.inner = { kind: 'custom', ...current.shadows.inner };
  }
  return base;
}

export interface CopiedStyle {
  tag: string;
  file: string;
  values: StyleDraft;
}

const PASTED_STROKES = ['solid', 'dashed', 'dotted'] as const;
const FULL_RADIUS_PX = 999;
const BLACK: HexColor = { hex: '#000000', opacity: 100 };

function themedColor(style: ElementStyle, group: StyleGroup): FillValue | null {
  const name = baseToken(style, group, 'color')?.themeToken;
  return name && style.theme.colors.some((color) => color.name === name)
    ? { kind: 'token', name }
    : null;
}

function hexFill(color: HexColor): FillValue {
  return { kind: 'hex', hex: color.hex, opacity: color.opacity };
}

export function copiedStyle(style: ElementStyle, current: Current): StyleDraft {
  const values: StyleDraft = {};
  if (current.fill && current.fill.opacity > 0) {
    values.fill = themedColor(style, 'fill') ?? hexFill(current.fill);
  }
  if (current.radiusPx !== null && current.radiusPx > 0) {
    const name = baseToken(style, 'radius', 'radius')?.themeToken;
    values.radius =
      name === 'full' || current.radiusPx >= FULL_RADIUS_PX
        ? { kind: 'full' }
        : name && style.theme.radii.some((radius) => radius.name === name)
          ? { kind: 'token', name }
          : { kind: 'px', px: Math.round(current.radiusPx) };
  }
  if (current.border.width > 0 && current.border.style !== 'none') {
    const line = PASTED_STROKES.find((value) => value === current.border.style) ?? 'solid';
    values.stroke = {
      kind: 'set',
      width: Math.round(current.border.width),
      style: line,
      color: themedColor(style, 'stroke') ?? hexFill(current.border.color ?? BLACK),
    };
  }
  if (!TEXTLESS_TAGS.has(style.tag)) {
    const family = baseToken(style, 'text', 'family')?.themeToken;
    values.text = {
      ...(family && style.theme.fonts.includes(family) ? { family } : {}),
      ...(current.fontWeight === null ? {} : { weight: Math.round(current.fontWeight) }),
      ...(current.fontSize === null ? {} : { size: current.fontSize }),
      ...(current.lineHeight === null ? {} : { lineHeight: current.lineHeight }),
      letterSpacing: current.letterSpacing,
      align: current.align,
      color: themedColor(style, 'text') ?? hexFill(current.color ?? BLACK),
    };
  }
  const effects = effectsBase(style, current);
  if (effects.drop || effects.inner) values.effects = effects;
  if (current.opacity < 100) values.opacity = current.opacity;
  const padding = current.padding;
  if (SIDES.some((side) => padding[side] > 0)) values.layout = { padding: { ...padding } };
  if (current.flow && (current.gap.row > 0 || current.gap.column > 0)) {
    values.layout = { ...values.layout, gap: { ...current.gap } };
  }
  return values;
}

function colorValue(fill: FillValue, style: ElementStyle): HexColor | null {
  if (fill.kind === 'none') return null;
  if (fill.kind === 'hex') return { hex: fill.hex.toUpperCase(), opacity: fill.opacity };
  const hex = parseHex(style.theme.colors.find((color) => color.name === fill.name)?.value ?? '');
  return hex ? { hex, opacity: 100 } : null;
}

function sameColor(fill: FillValue, current: HexColor | null, style: ElementStyle): boolean {
  const wanted = colorValue(fill, style);
  if (!wanted || !current) return wanted === null && (current === null || current.opacity === 0);
  return wanted.hex === current.hex && wanted.opacity === current.opacity;
}

function near(a: number | null | undefined, b: number | null | undefined, within = 0.01): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) < within;
}

function shadowValueOf(
  shadow: ShadowValue | undefined,
  inset: boolean,
  style: ElementStyle,
): Shadow | null {
  if (!shadow) return null;
  if (shadow.kind === 'custom') return shadow;
  const value = style.theme.shadows.find(
    (entry) => entry.name === shadow.name && entry.inset === inset,
  )?.value;
  const parsed = parseShadows(value ?? '');
  return inset ? parsed.inner : parsed.drop;
}

function sameShadow(a: Shadow | null, b: Shadow | null): boolean {
  if (!a || !b) return a === b;
  return (
    near(a.x, b.x) &&
    near(a.y, b.y) &&
    near(a.blur, b.blur) &&
    near(a.spread, b.spread) &&
    a.hex.toUpperCase() === b.hex.toUpperCase() &&
    a.opacity === b.opacity
  );
}

function radiusPxOf(radius: RadiusValue, style: ElementStyle): number | null {
  if (radius.kind === 'full') return FULL_RADIUS_PX;
  if (radius.kind === 'px') return radius.px;
  return style.theme.radii.find((entry) => entry.name === radius.name)?.px ?? null;
}

export function pastedDraft(values: StyleDraft, target: Current, style: ElementStyle): StyleDraft {
  const draft: StyleDraft = {};
  if (values.fill && !sameColor(values.fill, target.fill, style)) draft.fill = values.fill;
  if (values.radius) {
    const wanted = radiusPxOf(values.radius, style);
    const full = wanted === FULL_RADIUS_PX && (target.radiusPx ?? 0) >= FULL_RADIUS_PX;
    if (!full && !near(wanted, target.radiusPx)) draft.radius = values.radius;
  }
  if (values.stroke?.kind === 'set') {
    const { width, style: line, color } = values.stroke;
    const bare = target.border.style === 'none' || target.border.width === 0;
    const stroke: StrokeValue = { kind: 'set' };
    if (width !== undefined && (bare || !near(width, target.border.width))) stroke.width = width;
    if (line && (bare || line !== target.border.style)) stroke.style = line;
    if (color && (bare || !sameColor(color, target.border.color, style))) stroke.color = color;
    if (Object.keys(stroke).length > 1) draft.stroke = stroke;
  }
  if (values.text && !TEXTLESS_TAGS.has(style.tag)) {
    const wanted = values.text;
    const family = baseToken(style, 'text', 'family')?.themeToken;
    const text: TextValue = {};
    if (wanted.family && wanted.family !== family) text.family = wanted.family;
    if (wanted.weight !== undefined && !near(wanted.weight, target.fontWeight)) {
      text.weight = wanted.weight;
    }
    if (wanted.size !== undefined && !near(wanted.size, target.fontSize)) text.size = wanted.size;
    if (wanted.lineHeight !== undefined && !near(wanted.lineHeight, target.lineHeight)) {
      text.lineHeight = wanted.lineHeight;
    }
    if (
      wanted.letterSpacing !== undefined &&
      !near(wanted.letterSpacing, target.letterSpacing, 0.001)
    ) {
      text.letterSpacing = wanted.letterSpacing;
    }
    if (wanted.align && wanted.align !== target.align) text.align = wanted.align;
    if (wanted.color && !sameColor(wanted.color, target.color, style)) text.color = wanted.color;
    if (Object.keys(text).length > 0) draft.text = text;
  }
  if (values.effects) {
    const same =
      sameShadow(shadowValueOf(values.effects.drop, false, style), target.shadows.drop) &&
      sameShadow(shadowValueOf(values.effects.inner, true, style), target.shadows.inner);
    if (!same) draft.effects = values.effects;
  }
  if (values.opacity !== undefined && values.opacity !== target.opacity) {
    draft.opacity = values.opacity;
  }
  const padding: PaddingValue = {};
  for (const side of SIDES) {
    const wanted = values.layout?.padding?.[side];
    if (wanted !== undefined && !near(wanted, target.padding[side])) padding[side] = wanted;
  }
  const gap: GapValue = {};
  if (target.flow) {
    for (const axis of ['row', 'column'] as const) {
      const wanted = values.layout?.gap?.[axis];
      if (wanted !== undefined && !near(wanted, target.gap[axis])) gap[axis] = wanted;
    }
  }
  const hasPadding = Object.keys(padding).length > 0;
  const hasGap = Object.keys(gap).length > 0;
  if (hasPadding || hasGap) {
    draft.layout = { ...(hasPadding ? { padding } : {}), ...(hasGap ? { gap } : {}) };
  }
  return draft;
}

export function copiedGroups(values: StyleDraft): StyleGroup[] {
  return SECTION_ORDER.filter((group) => values[group as keyof StyleDraft] !== undefined);
}

export function pickedValues(values: StyleDraft, groups: readonly StyleGroup[]): StyleDraft {
  return Object.fromEntries(
    Object.entries(values).filter(([group]) => groups.includes(group as StyleGroup)),
  ) as StyleDraft;
}

export function isCopyShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'code'>,
): boolean {
  return (
    event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyC'
  );
}
