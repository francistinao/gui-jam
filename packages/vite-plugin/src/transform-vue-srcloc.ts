import MagicString, { type SourceMap } from 'magic-string';
import { SRC_ATTRIBUTE } from './transform-srcloc.js';

const ELEMENT_NODE = 1;
const PLAIN_ELEMENT = 0;
const COMPONENT = 1;
const BUILT_INS = new Set([
  'component',
  'transition',
  'transitiongroup',
  'keepalive',
  'teleport',
  'suspense',
  'routerview',
  'nuxtpage',
  'nuxtlayout',
  'clientonly',
]);
const VUE_IMPORT = /import\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"][^'"]+\.vue['"]/g;

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

interface SfcBlock {
  content: string;
}

export interface VueSfcCompiler {
  parse(
    source: string,
    options: { filename: string; sourceMap: boolean },
  ): {
    descriptor: {
      template: { ast?: VueNode | null } | null;
      script?: SfcBlock | null;
      scriptSetup?: SfcBlock | null;
    };
    errors: readonly unknown[];
  };
}

function normalized(tag: string): string {
  return tag.replaceAll('-', '').toLowerCase();
}

function localComponents(...blocks: (SfcBlock | null | undefined)[]): Set<string> {
  const names = new Set<string>();
  for (const block of blocks) {
    for (const match of block?.content.matchAll(VUE_IMPORT) ?? []) {
      if (match[1]) names.add(normalized(match[1]));
    }
  }
  return names;
}

function markable(node: VueNode, local: ReadonlySet<string>): boolean {
  if (node.type !== ELEMENT_NODE || node.tag === undefined) return false;
  if (node.tagType === PLAIN_ELEMENT) return true;
  if (node.tagType !== COMPONENT) return false;
  const name = normalized(node.tag);
  return !BUILT_INS.has(name) && !local.has(name);
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
  id: string,
  projectPath: string,
  compiler: VueSfcCompiler,
): AnnotatedVue | null {
  const { descriptor, errors } = compiler.parse(code, { filename: projectPath, sourceMap: false });
  const root = descriptor.template?.ast;
  if (!root || errors.length > 0) return null;
  const local = localComponents(descriptor.script, descriptor.scriptSetup);
  const output = new MagicString(code);
  let changed = false;
  const visit = (node: VueNode): void => {
    if (markable(node, local) && node.tag !== undefined && !marked(node)) {
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
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: id, includeContent: true }),
  };
}
