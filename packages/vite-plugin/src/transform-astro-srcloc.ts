import MagicString, { type SourceMap } from 'magic-string';
import { locate, SRC_ATTRIBUTE } from './transform-srcloc.js';

export interface AstroNode {
  type?: string;
  start?: number;
  end?: number;
  name?: unknown;
  [key: string]: unknown;
}

export interface AstroCompiler {
  parse(source: string): { ast: AstroNode };
}

export interface AnnotatedAstro {
  code: string;
  map: SourceMap;
}

const SKIPPED_SUBTREES = new Set(['head', 'script', 'style']);
const UNMARKED_ELEMENTS = new Set(['html', 'slot']);
const HTML_ELEMENT = /^[a-z][\w-]*$/;

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let index = code.indexOf('\n'); index !== -1; index = code.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function nodeOf(value: unknown): AstroNode | undefined {
  return typeof value === 'object' && value !== null ? (value as AstroNode) : undefined;
}

function tagName(opening: AstroNode | undefined): { name: string; end: number } | undefined {
  const name = nodeOf(opening?.name);
  if (name?.type !== 'JSXIdentifier' || typeof name.name !== 'string') return undefined;
  if (typeof name.end !== 'number') return undefined;
  return { name: name.name, end: name.end };
}

function marked(opening: AstroNode): boolean {
  const attributes = Array.isArray(opening.attributes) ? opening.attributes : [];
  return attributes.some((attribute) => {
    const name = nodeOf(nodeOf(attribute)?.name);
    return name?.name === SRC_ATTRIBUTE;
  });
}

function children(node: AstroNode): AstroNode[] {
  return Object.entries(node).flatMap(([key, value]): AstroNode[] => {
    if (key === 'frontmatter' || key === 'comments') return [];
    const items: unknown[] = Array.isArray(value) ? value : [value];
    return items.flatMap<AstroNode>((item) => nodeOf(item) ?? []);
  });
}

export function injectAstroSourceLocations(
  code: string,
  id: string,
  projectPath: string,
  compiler: AstroCompiler,
): AnnotatedAstro | null {
  let root: AstroNode;
  try {
    root = compiler.parse(code).ast;
  } catch {
    return null;
  }
  const lineStarts = lineStartsOf(code);
  const output = new MagicString(code);
  let changed = false;
  const visit = (node: AstroNode): void => {
    if (node.type === 'JSXElement') {
      const opening = nodeOf(node.openingElement);
      const tag = tagName(opening);
      if (tag && SKIPPED_SUBTREES.has(tag.name)) return;
      if (
        opening &&
        tag &&
        HTML_ELEMENT.test(tag.name) &&
        !UNMARKED_ELEMENTS.has(tag.name) &&
        typeof node.start === 'number' &&
        !marked(opening)
      ) {
        const { line, column } = locate(lineStarts, node.start);
        output.appendLeft(tag.end, ` ${SRC_ATTRIBUTE}="${projectPath}:${line}:${column}"`);
        changed = true;
      }
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
