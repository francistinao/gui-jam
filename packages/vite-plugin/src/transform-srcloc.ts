import MagicString, { type SourceMap } from 'magic-string';
import { type Expression, type Program, parseSync, Visitor } from 'oxc-parser';

export const SRC_ATTRIBUTE = 'data-gj-src';

export interface SrcLoc {
  line: number;
  column: number;
}

export interface AnnotatedModule {
  code: string;
  map: SourceMap;
}

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let index = code.indexOf('\n'); index !== -1; index = code.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

export function locate(lineStarts: readonly number[], offset: number): SrcLoc {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (lineStarts[low] ?? 0) + 1 };
}

function isIntrinsic(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 97 && first <= 122;
}

const TAG_NAME = /^[a-z][a-z0-9-]*$/;

function mayHoldTagName(node: Expression | null | undefined): boolean {
  if (!node) return false;
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' && TAG_NAME.test(node.value);
    case 'ConditionalExpression':
      return mayHoldTagName(node.consequent) || mayHoldTagName(node.alternate);
    case 'LogicalExpression':
      return mayHoldTagName(node.left) || mayHoldTagName(node.right);
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return mayHoldTagName(node.expression);
    default:
      return false;
  }
}

function polymorphicTagNames(program: Program): Set<string> {
  const names = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      if (
        node.id.type === 'Identifier' &&
        !isIntrinsic(node.id.name) &&
        mayHoldTagName(node.init)
      ) {
        names.add(node.id.name);
      }
    },
  }).visit(program);
  return names;
}

export function injectSourceLocations(
  code: string,
  id: string,
  projectPath: string,
  prepend = '',
): AnnotatedModule | null {
  const parsed = parseSync(id, code);
  if (parsed.errors.length > 0) return null;

  const lineStarts = lineStartsOf(code);
  const attributePath = projectPath.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const output = new MagicString(code);
  const polymorphic = polymorphicTagNames(parsed.program);
  let annotated = 0;

  new Visitor({
    JSXOpeningElement(node) {
      if (node.name.type !== 'JSXIdentifier') return;
      const { name } = node.name;
      if (!isIntrinsic(name) && !polymorphic.has(name)) return;
      const alreadyAnnotated = node.attributes.some(
        (attribute) =>
          attribute.type === 'JSXAttribute' &&
          attribute.name.type === 'JSXIdentifier' &&
          attribute.name.name === SRC_ATTRIBUTE,
      );
      if (alreadyAnnotated) return;
      const { line, column } = locate(lineStarts, node.start);
      output.appendLeft(node.name.end, ` ${SRC_ATTRIBUTE}="${attributePath}:${line}:${column}"`);
      annotated += 1;
    },
  }).visit(parsed.program);

  if (annotated === 0 && prepend === '') return null;
  output.prepend(prepend);
  return {
    code: output.toString(),
    map: output.generateMap({ source: id, includeContent: true, hires: 'boundary' }),
  };
}
