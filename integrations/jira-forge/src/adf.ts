import type { CodeChange } from './generated/bridge';

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'panel']);

export function doc(...content: AdfNode[]): AdfDoc {
  return { type: 'doc', version: 1, content };
}

export function text(value: string, ...marks: string[]): AdfNode {
  return marks.length > 0
    ? { type: 'text', text: value, marks: marks.map((type) => ({ type })) }
    : { type: 'text', text: value };
}

export function link(value: string, href: string): AdfNode {
  return { type: 'text', text: value, marks: [{ type: 'link', attrs: { href } }] };
}

export function mention(accountId: string): AdfNode {
  return { type: 'mention', attrs: { id: accountId } };
}

export function paragraph(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

export function heading(level: number, value: string): AdfNode {
  return { type: 'heading', attrs: { level }, content: [text(value)] };
}

export function codeBlock(value: string, language?: string): AdfNode {
  return {
    type: 'codeBlock',
    ...(language ? { attrs: { language } } : {}),
    content: value ? [text(value)] : [],
  };
}

export function bulletList(items: AdfNode[][]): AdfNode {
  return {
    type: 'bulletList',
    content: items.map((content) => ({ type: 'listItem', content: [paragraph(...content)] })),
  };
}

export function plainText(node: unknown): string {
  const out: string[] = [];
  const walk = (value: unknown, prefix: string): void => {
    if (typeof value !== 'object' || value === null) return;
    const entry = value as AdfNode;
    if (entry.type === 'text' && typeof entry.text === 'string') {
      out.push(entry.text);
      return;
    }
    if (entry.type === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (entry.type === 'mention') {
      const label = entry.attrs?.text;
      out.push(typeof label === 'string' ? label : '@someone');
      return;
    }
    if (entry.type === 'listItem') out.push(prefix);
    for (const child of entry.content ?? []) {
      walk(child, entry.type === 'orderedList' ? '1. ' : '- ');
    }
    if (BLOCKS.has(entry.type)) out.push('\n');
  };
  walk(node, '- ');
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function diffText(changes: readonly CodeChange[]): string {
  return changes
    .map((change) =>
      [
        `@@ ${change.file}:${change.line}`,
        ...change.before.map((line) => `- ${line}`),
        ...change.after.map((line) => `+ ${line}`),
      ].join('\n'),
    )
    .join('\n');
}
