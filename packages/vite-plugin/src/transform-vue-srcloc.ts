import MagicString, { type SourceMap } from 'magic-string';
import { SRC_ATTRIBUTE } from './transform-srcloc.js';

const ELEMENT_NODE = 1;
const PLAIN_ELEMENT = 0;

interface Position {
  offset: number;
  line: number;
  column: number;
}

export interface VueNode {
  type: number;
  tag?: string;
  tagType?: number;
  loc: { start: Position };
  props?: readonly { name: string }[];
  children?: readonly VueNode[];
}

export interface VueSfcCompiler {
  parse(
    source: string,
    options: { filename: string; sourceMap: boolean },
  ): { descriptor: { template: { ast?: VueNode | null } | null }; errors: readonly unknown[] };
}

export interface AnnotatedVue {
  code: string;
  map: SourceMap;
}

function marked(node: VueNode): boolean {
  return (node.props ?? []).some((prop) => prop.name === SRC_ATTRIBUTE);
}

export function injectVueSourceLocations(
  code: string,
  projectPath: string,
  compiler: VueSfcCompiler,
): AnnotatedVue | null {
  const { descriptor, errors } = compiler.parse(code, { filename: projectPath, sourceMap: false });
  const root = descriptor.template?.ast;
  if (!root || errors.length > 0) return null;
  const output = new MagicString(code);
  let changed = false;
  const visit = (node: VueNode): void => {
    if (
      node.type === ELEMENT_NODE &&
      node.tagType === PLAIN_ELEMENT &&
      node.tag !== undefined &&
      !marked(node)
    ) {
      const { offset, line, column } = node.loc.start;
      output.appendLeft(
        offset + 1 + node.tag.length,
        ` ${SRC_ATTRIBUTE}="${projectPath}:${line}:${column}"`,
      );
      changed = true;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of root.children ?? []) visit(child);
  if (!changed) return null;
  return { code: output.toString(), map: output.generateMap({ hires: true, source: projectPath }) };
}
