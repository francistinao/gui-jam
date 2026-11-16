import type { PageItem } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import { clip, prioritize, urlPath } from './page-outline';

const at = (kind: PageItem['kind'], text: string): PageItem => ({
  kind,
  tag: kind === 'landmark' ? 'nav' : 'a',
  text,
  box: [0, 0, 10, 10],
});

describe('page outline', () => {
  it('keeps the URL path of an image and drops queries and the site root', () => {
    expect(urlPath('http://localhost:5173/src/assets/logo.png?t=1', 'http://localhost:5173/')).toBe(
      '/src/assets/logo.png',
    );
    expect(urlPath('/cup.svg', 'http://127.0.0.1:8000/menu')).toBe('/cup.svg');
    expect(urlPath('http://localhost:5173/', 'http://localhost:5173/')).toBeNull();
  });

  it('collapses whitespace and cuts long text', () => {
    expect(clip('  Menu\n   Branches ', 40)).toBe('Menu Branches');
    expect(clip('x'.repeat(10), 5)).toBe('xxxx…');
  });

  it('keeps landmarks and images over links when the page is long, in page order', () => {
    const links = Array.from({ length: 160 }, (_, n) => at('link', `link ${n}`));
    const landmark = at('landmark', 'nav');
    const image = at('image', 'logo');

    const kept = prioritize([...links.slice(0, 5), image, ...links.slice(5), landmark]);

    expect(kept).toHaveLength(150);
    expect(kept.slice(0, 6).map((item) => item.text)).toEqual([
      'link 0',
      'link 1',
      'link 2',
      'link 3',
      'link 4',
      'logo',
    ]);
    expect(kept.at(-1)?.text).toBe('nav');
  });
});
