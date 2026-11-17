import { describe, expect, it } from 'vitest';
import { hotReloadable, overlayFile, resolveOverlay } from './overlay-resolve.js';

const ROOT = '/repo/app';

function lookup(overlays: string[], disk: string[] = []) {
  const shown = new Set(overlays);
  const saved = new Set(disk);
  return { root: ROOT, has: (id: string) => shown.has(id), onDisk: (id: string) => saved.has(id) };
}

describe('resolveOverlay', () => {
  const importer = `${ROOT}/src/components/OrderButton.tsx`;
  const organism = `${ROOT}/src/components/organisms/PricingSection.tsx`;

  it.each([
    ['./organisms/PricingSection', organism],
    ['./organisms/PricingSection.tsx', organism],
    ['./organisms/PricingSection?import', `${organism}?import`],
    ['/src/components/organisms/PricingSection', organism],
    [`${ROOT}/src/components/organisms/PricingSection`, organism],
  ])('finds %s', (source, expected) => {
    expect(resolveOverlay(source, importer, lookup([organism]))).toBe(expected);
  });

  it('finds an aliased import that Vite resolved to a Windows drive path', () => {
    const windows = 'C:/repo/app/src/components/organisms/PricingSection.tsx';
    const overlays = { ...lookup([windows]), root: 'C:/repo/app' };
    expect(
      resolveOverlay('C:/repo/app/src/components/organisms/PricingSection', undefined, overlays),
    ).toBe(windows);
  });

  it('resolves imports between new files relative to the importing overlay', () => {
    const atom = `${ROOT}/src/components/atoms/Price.tsx`;
    expect(resolveOverlay('../atoms/Price', `${organism}?t=1`, lookup([organism, atom]))).toBe(
      atom,
    );
  });

  it('tries each extension, then an index file, in order', () => {
    const index = `${ROOT}/src/components/organisms/Plans/index.tsx`;
    const jsx = `${ROOT}/src/components/organisms/Plans.jsx`;
    expect(resolveOverlay('./organisms/Plans', importer, lookup([index]))).toBe(index);
    expect(resolveOverlay('./organisms/Plans', importer, lookup([index, jsx]))).toBe(jsx);
  });

  it('leaves files on disk, bare packages and unknown paths to Vite', () => {
    expect(
      resolveOverlay('./organisms/PricingSection', importer, lookup([organism], [organism])),
    ).toBe(null);
    expect(resolveOverlay('react', importer, lookup([organism]))).toBe(null);
    expect(resolveOverlay('./organisms/Missing', importer, lookup([organism]))).toBe(null);
    expect(resolveOverlay('./organisms/PricingSection', undefined, lookup([organism]))).toBe(null);
  });
});

describe('overlayFile', () => {
  it.each([
    ['/app/src/routes/index.tsx', '/app/src/routes/index.tsx'],
    ['/app/src/routes/index.tsx?pick=default&pick=$css&lang.tsx', '/app/src/routes/index.tsx'],
    ['/app/src/routes/index.tsx?pick=route', '/app/src/routes/index.tsx'],
    [
      '/app/src/App.vue?vue&type=style&index=0&lang.css',
      '/app/src/App.vue?vue&type=style&index=0&lang.css',
    ],
    [
      '/app/src/Card.svelte?svelte&type=style&lang.css',
      '/app/src/Card.svelte?svelte&type=style&lang.css',
    ],
    ['/app/src/routes/index.tsx?pick=default&raw', '/app/src/routes/index.tsx?pick=default&raw'],
    ['/app/src/logo.svg?url', '/app/src/logo.svg?url'],
  ])('%s reads the overlay of %s', (id, expected) => {
    expect(overlayFile(id)).toBe(expected);
  });
});

describe('hotReloadable', () => {
  it.each([
    ['/src/pages/login.vue', true],
    ['/src/pages/login.vue?vue&type=style&index=0&lang.scss', true],
    ['/src/index.css?direct', true],
    ['/src/pages/login.vue?definePage&vue', false],
    ['/pages/index.vue?macro=true', false],
  ])('%s → %s', (url, expected) => {
    expect(hotReloadable(url)).toBe(expected);
  });
});
