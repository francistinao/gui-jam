import type { PageItem, PageOutline } from '@guijam/contracts-ts';

const MAX_ITEMS = 150;
const SRC_ATTRIBUTE = 'data-gj-src';
const LANDMARKS = 'header, nav, main, footer, aside';
const SELECTOR = `${LANDMARKS}, h1, h2, h3, img, svg[role="img"], a[href], button`;
const PRIORITY: readonly PageItem['kind'][] = ['landmark', 'image', 'heading', 'button', 'link'];
const BACKGROUND_URL = /url\(["']?([^"')]+)["']?\)/;

export function clip(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

export function urlPath(url: string, base: string): string | null {
  try {
    const { pathname } = new URL(url, base);
    return pathname === '/' ? null : clip(pathname, 300);
  } catch {
    return null;
  }
}

export function prioritize(items: readonly PageItem[]): PageItem[] {
  return items
    .map((item, order) => ({ item, order }))
    .sort(
      (a, b) => PRIORITY.indexOf(a.item.kind) - PRIORITY.indexOf(b.item.kind) || a.order - b.order,
    )
    .slice(0, MAX_ITEMS)
    .sort((a, b) => a.order - b.order)
    .map(({ item }) => item);
}

function kindOf(element: Element): PageItem['kind'] {
  const tag = element.tagName.toLowerCase();
  if (element.matches(LANDMARKS)) return 'landmark';
  if (tag === 'img' || tag === 'svg') return 'image';
  if (/^h[1-3]$/.test(tag)) return 'heading';
  return tag === 'button' ? 'button' : 'link';
}

function textOf(element: Element, kind: PageItem['kind']): string {
  if (kind === 'image')
    return element.getAttribute('alt') ?? element.getAttribute('aria-label') ?? '';
  if (kind === 'landmark') return element.getAttribute('aria-label') ?? '';
  return element.textContent ?? '';
}

function item(element: Element, kind: PageItem['kind'], url: string | null): PageItem | null {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const outlined: PageItem = {
    kind,
    tag: element.tagName.toLowerCase().slice(0, 40),
    text: clip(textOf(element, kind), 120),
    box: [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
    ],
  };
  const region = element.parentElement?.closest(LANDMARKS)?.tagName.toLowerCase();
  if (region) outlined.region = region;
  const src = element.closest(`[${SRC_ATTRIBUTE}]`)?.getAttribute(SRC_ATTRIBUTE);
  if (src) outlined.src = clip(src, 300);
  if (url) outlined.url = url;
  return outlined;
}

export function collectPageOutline(page: Document, exclude: Element): PageOutline {
  const base = page.baseURI;
  const items: PageItem[] = [];
  const seen = new Set<Element>();
  for (const element of page.querySelectorAll(SELECTOR)) {
    if (exclude.contains(element)) continue;
    seen.add(element);
    const kind = kindOf(element);
    const source = element instanceof HTMLImageElement ? element.currentSrc || element.src : null;
    const outlined = item(element, kind, source ? urlPath(source, base) : null);
    if (outlined) items.push(outlined);
  }
  for (const element of page.querySelectorAll(`[${SRC_ATTRIBUTE}]`)) {
    if (seen.has(element) || exclude.contains(element)) continue;
    const background = BACKGROUND_URL.exec(getComputedStyle(element).backgroundImage)?.[1];
    if (!background) continue;
    const outlined = item(element, 'image', urlPath(background, base));
    if (outlined) items.push(outlined);
  }
  return { items: prioritize(items) };
}
