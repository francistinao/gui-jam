import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { type Expression, type ObjectExpression, parseSync, Visitor } from 'oxc-parser';
import type { Project } from './detect.js';
import { sourceText } from './wire.js';

const PWA_SOURCE = 'vite-plugin-pwa';

export const PWA_HINT =
  'vite-plugin-pwa runs a service worker in development. It can serve a cached page without the toolbar; if the toolbar is missing, clear the site data for this address in DevTools.';

function property(object: ObjectExpression, name: string): Expression | undefined {
  for (const entry of object.properties) {
    if (entry.type !== 'Property' || entry.computed) continue;
    const { key } = entry;
    const matches =
      (key.type === 'Identifier' && key.name === name) ||
      (key.type === 'Literal' && key.value === name);
    if (matches) return entry.value;
  }
  return undefined;
}

function enablesDevWorker(options: Expression | undefined): boolean {
  if (options?.type !== 'ObjectExpression') return false;
  const dev = property(options, 'devOptions');
  if (dev?.type !== 'ObjectExpression') return false;
  const enabled = property(dev, 'enabled');
  return enabled?.type === 'Literal' && enabled.value === true;
}

export function runsDevServiceWorker(code: string, filename = 'vite.config.ts'): boolean {
  const parsed = parseSync(filename, code);
  if (parsed.errors.length > 0) return false;
  const locals = new Set<string>();
  for (const statement of parsed.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== PWA_SOURCE) continue;
    for (const specifier of statement.specifiers) locals.add(specifier.local.name);
  }
  if (locals.size === 0) return false;
  let found = false;
  new Visitor({
    CallExpression(node) {
      if (node.callee.type !== 'Identifier' || !locals.has(node.callee.name)) return;
      const [first] = node.arguments;
      if (first && first.type !== 'SpreadElement' && enablesDevWorker(first)) found = true;
    },
  }).visit(parsed.program);
  return found;
}

export async function projectRunsDevServiceWorker(project: Project): Promise<boolean> {
  if (project.configFile === undefined) return false;
  try {
    return runsDevServiceWorker(
      sourceText(await readFile(project.configFile, 'utf8')).code,
      basename(project.configFile),
    );
  } catch {
    return false;
  }
}
