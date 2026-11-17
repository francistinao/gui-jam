import { dirname, resolve } from 'node:path';
import { normalizePath } from 'vite';

export const PROBED_SUFFIXES = [
  '',
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '/index.tsx',
  '/index.ts',
  '/index.jsx',
  '/index.js',
] as const;

export interface OverlayLookup {
  root: string;
  has: (id: string) => boolean;
  onDisk: (id: string) => boolean;
}

function bases(path: string, importer: string | undefined, root: string): string[] {
  if (path.startsWith('/')) {
    return [normalizePath(path), normalizePath(resolve(root, `.${path}`))];
  }
  if (path.startsWith('./') || path.startsWith('../')) {
    const from = importer?.split('?', 1)[0];
    return from ? [normalizePath(resolve(dirname(from), path))] : [];
  }
  return [];
}

export function resolveOverlay(
  source: string,
  importer: string | undefined,
  lookup: OverlayLookup,
): string | null {
  const [path = '', query] = source.split('?', 2);
  for (const base of bases(path, importer, lookup.root)) {
    for (const suffix of PROBED_SUFFIXES) {
      const id = `${base}${suffix}`;
      if (lookup.has(id) && !lookup.onDisk(id)) return query === undefined ? id : `${id}?${query}`;
    }
  }
  return null;
}

const MACRO_QUERIES = ['definePage', 'macro'];

export function hotReloadable(url: string): boolean {
  const query = url.split('?', 2)[1];
  if (query === undefined) return true;
  const keys = [...new URLSearchParams(query).keys()];
  return !keys.some((key) => MACRO_QUERIES.includes(key));
}
