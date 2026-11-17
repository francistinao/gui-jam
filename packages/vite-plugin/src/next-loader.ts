import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import {
  candidatesDirOf,
  insideProject,
  overlayFileOf,
  TAILWIND_ROOT,
  toPosix,
} from './next-paths.js';
import { injectSourceLocations } from './transform-srcloc.js';

export interface LoaderOptions {
  root: string;
}

interface LoaderContext {
  resourcePath: string;
  addDependency(file: string): void;
  getOptions?(): unknown;
  query?: unknown;
}

const STYLESHEET = /\.css$/;

function optionsOf(context: LoaderContext): LoaderOptions {
  const raw = typeof context.getOptions === 'function' ? context.getOptions() : context.query;
  const root =
    typeof raw === 'object' && raw !== null ? (raw as { root?: unknown }).root : undefined;
  if (typeof root !== 'string') throw new Error('guijam/next loader: the root option is missing');
  return { root };
}

function overlayOf(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8');
  return content.length > 0 ? content : undefined;
}

export default function guijamLoader(this: LoaderContext, source: string): string {
  const { root } = optionsOf(this);
  const file = this.resourcePath;
  const projectPath = insideProject(root, file);
  if (projectPath === undefined || projectPath.includes('node_modules/')) return source;
  if (STYLESHEET.test(file)) {
    if (!TAILWIND_ROOT.test(source)) return source;
    const candidates = toPosix(relative(dirname(file), candidatesDirOf(root)));
    return `${source}\n@source "${candidates}";\n`;
  }
  const overlay = overlayFileOf(root, projectPath);
  this.addDependency(overlay);
  const shown = overlayOf(overlay) ?? source;
  return injectSourceLocations(shown, file, projectPath)?.code ?? shown;
}
