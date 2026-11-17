import MagicString, { type SourceMap } from 'magic-string';
import { locate, SRC_ATTRIBUTE } from './transform-srcloc.js';

export interface SvelteNode {
  type?: string;
  name?: string;
  start?: number;
  attributes?: readonly { type?: string; name?: string }[];
  [key: string]: unknown;
}

export interface SvelteCompiler {
  parse(source: string, options: { modern: true; filename: string }): { fragment: SvelteNode };
}

export interface AnnotatedSvelte {
  code: string;
  map: SourceMap;
}

const SKIPPED_CHILDREN = new Set(['SvelteHead', 'Script', 'StyleSheet']);

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let index = code.indexOf('\n'); index !== -1; index = code.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function marked(node: SvelteNode): boolean {
  return (node.attributes ?? []).some((attribute) => attribute.name === SRC_ATTRIBUTE);
}

function children(node: SvelteNode): SvelteNode[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === 'attributes' || key === 'metadata') return [];
    if (Array.isArray(value)) {
      return value.filter((item): item is SvelteNode => typeof item === 'object' && item !== null);
    }
    return typeof value === 'object' && value !== null ? [value as SvelteNode] : [];
  });
}

export function injectSvelteSourceLocations(
  code: string,
  id: string,
  projectPath: string,
  compiler: SvelteCompiler,
): AnnotatedSvelte | null {
  let root: SvelteNode;
  try {
    root = compiler.parse(code, { modern: true, filename: projectPath }).fragment;
  } catch {
    return null;
  }
  const lineStarts = lineStartsOf(code);
  const output = new MagicString(code);
  let changed = false;
  const visit = (node: SvelteNode): void => {
    if (node.type !== undefined && SKIPPED_CHILDREN.has(node.type)) return;
    if (
      node.type === 'RegularElement' &&
      typeof node.name === 'string' &&
      typeof node.start === 'number' &&
      !marked(node)
    ) {
      const { line, column } = locate(lineStarts, node.start);
      output.appendLeft(
        node.start + 1 + node.name.length,
        ` ${SRC_ATTRIBUTE}="${projectPath}:${line}:${column}"`,
      );
      changed = true;
    }
    for (const child of children(node)) visit(child);
  };
  visit(root);
  if (!changed) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: id, includeContent: true }),
  };
}
