import type { ElementStyle, GenerateDone, StyleGroup, StyleToken } from '@guijam/contracts-ts';

export type { Tool } from './host';

export interface Range {
  min: number;
  max: number;
}

export const RADIUS_RANGE: Range = { min: 0, max: 999 };
export const OPACITY_RANGE: Range = { min: 0, max: 100 };

const WRITABLE: ReadonlySet<StyleGroup> = new Set<StyleGroup>(['radius', 'fill']);

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

export interface Point {
  x: number;
  y: number;
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

export interface WorkContext {
  sketch: boolean;
  images: number;
  links: number;
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
  if (elapsedMs < SLOW_MS) {
    return context.sketch || context.images > 0
      ? 'Still generating. Sketches and new components usually take 20 to 60 s.'
      : 'Still generating. Most changes take 10 to 40 s.';
  }
  if (elapsedMs < VERY_SLOW_MS) return reason(context);
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
