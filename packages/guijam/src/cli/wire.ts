import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { supportsNext } from '@guijam/vite-plugin/next/version';
import MagicString from 'magic-string';
import {
  type ArrayExpression,
  type ArrowFunctionExpression,
  type Directive,
  type Expression,
  type Function as FunctionNode,
  type ObjectExpression,
  type ObjectProperty,
  type Program,
  parseSync,
  type ReturnStatement,
  type Statement,
  Visitor,
} from 'oxc-parser';
import { type Project, VITE_FRAMEWORKS } from './detect.js';

export const PLUGIN_SOURCE = 'guijam/vite';
export const NUXT_MODULE = 'guijam/nuxt';
export const ASTRO_INTEGRATION = 'guijam/astro';
export const NEXT_WRAPPER = 'guijam/next';

interface Hook {
  source: string;
  imported: 'guijam' | 'default' | 'withGuijam';
  key: 'plugins' | 'integrations';
}

const VITE_HOOK: Hook = { source: PLUGIN_SOURCE, imported: 'guijam', key: 'plugins' };
const ASTRO_HOOK: Hook = { source: ASTRO_INTEGRATION, imported: 'default', key: 'integrations' };
const NEXT_HOOK: Hook = { source: NEXT_WRAPPER, imported: 'withGuijam', key: 'plugins' };

const MAX_HOPS = 8;

export type EditOutcome =
  | { kind: 'present' }
  | { kind: 'added'; code: string }
  | { kind: 'manual'; reason: string };

export type WireResult =
  | { status: 'added' | 'present' | 'created'; file: string }
  | { status: 'manual'; file: string; reason: string; snippet: string }
  | { status: 'unsupported'; reason: string };

type Scope = readonly (Statement | Directive)[];

type Found<T> = { node: T } | { problem: string };

interface Range {
  start: number;
  end: number;
}

interface Bodies {
  returns: ReturnStatement[];
  functions: Range[];
}

const COMING_SOON: Record<string, string> = {
  angular: 'Angular support is on the roadmap.',
  'solid-start-vinxi': 'SolidStart 1 runs on vinxi; upgrade to SolidStart 2, which runs on Vite.',
};

function guijamImportOf(program: Program, hook: Hook): string | undefined {
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== hook.source) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportDefaultSpecifier') {
        if (hook.imported === 'default') return specifier.local.name;
        continue;
      }
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported =
        specifier.imported.type === 'Literal' ? specifier.imported.value : specifier.imported.name;
      if (imported === hook.imported) return specifier.local.name;
    }
  }
  return undefined;
}

function calls(program: Program, name: string): boolean {
  let found = false;
  new Visitor({
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === name) found = true;
    },
  }).visit(program);
  return found;
}

function unwrap(expression: Expression): Expression {
  let current = expression;
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression'
  ) {
    current = current.expression;
  }
  return current;
}

function declaredIn(scope: Scope, name: string): Expression | undefined {
  for (const statement of scope) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      if (
        declarator.id.type === 'Identifier' &&
        declarator.id.name === name &&
        declarator.init !== null
      ) {
        return declarator.init;
      }
    }
  }
  return undefined;
}

function collectBodies(program: Program): Bodies {
  const returns: ReturnStatement[] = [];
  const functions: Range[] = [];
  const addFunction = (node: Range): void => {
    functions.push(node);
  };
  new Visitor({
    ReturnStatement(node) {
      returns.push(node);
    },
    FunctionDeclaration: addFunction,
    FunctionExpression: addFunction,
    ArrowFunctionExpression: addFunction,
  }).visit(program);
  return { returns, functions };
}

function contains(outer: Range, inner: Range): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function ownReturns(fn: Range, bodies: Bodies): ReturnStatement[] {
  const nested = bodies.functions.filter(
    (other) => (other.start !== fn.start || other.end !== fn.end) && contains(fn, other),
  );
  return bodies.returns.filter(
    (node) => contains(fn, node) && !nested.some((other) => contains(other, node)),
  );
}

function returnedFrom(
  fn: FunctionNode | ArrowFunctionExpression,
  scope: Scope,
  bodies: Bodies,
  hops: number,
): Found<ObjectExpression> {
  const { body } = fn;
  if (body === null || body === undefined) return { problem: 'its config function has no body' };
  if (body.type !== 'BlockStatement') return configObject(body, scope, bodies, hops + 1);
  const returns = ownReturns(fn, bodies);
  const [only] = returns;
  if (returns.length !== 1 || only === undefined || only.argument === null) {
    return { problem: 'its config function returns from more than one place' };
  }
  return configObject(only.argument, [...body.body, ...scope], bodies, hops + 1);
}

function configObject(
  expression: Expression,
  scope: Scope,
  bodies: Bodies,
  hops: number,
): Found<ObjectExpression> {
  if (hops > MAX_HOPS) return { problem: 'its config is too indirect' };
  const node = unwrap(expression);
  switch (node.type) {
    case 'ObjectExpression':
      return { node };
    case 'CallExpression': {
      const [first] = node.arguments;
      if (first === undefined || first.type === 'SpreadElement')
        return { problem: 'its config call has no argument' };
      return configObject(first, scope, bodies, hops + 1);
    }
    case 'Identifier': {
      const init = declaredIn(scope, node.name);
      if (init === undefined)
        return { problem: `it exports ${node.name}, which is not declared in the file` };
      return configObject(init, scope, bodies, hops + 1);
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return returnedFrom(node, scope, bodies, hops);
    default:
      return { problem: 'its default export is not a config object' };
  }
}

function exportedConfig(program: Program): Found<ObjectExpression> {
  const exported = program.body.find((statement) => statement.type === 'ExportDefaultDeclaration');
  if (exported === undefined) return { problem: 'it has no default export' };
  const { declaration } = exported;
  const bodies = collectBodies(program);
  if (declaration.type === 'FunctionDeclaration') {
    return returnedFrom(declaration, program.body, bodies, 0);
  }
  if (declaration.type === 'ClassDeclaration' || declaration.type === 'TSInterfaceDeclaration') {
    return { problem: 'its default export is not a config object' };
  }
  return configObject(declaration, program.body, bodies, 0);
}

function isKey(property: ObjectProperty, name: string): boolean {
  if (property.computed) return false;
  const { key } = property;
  return (
    (key.type === 'Identifier' && key.name === name) ||
    (key.type === 'Literal' && key.value === name)
  );
}

function insertFirst(
  output: MagicString,
  code: string,
  open: number,
  firstStart: number,
  text: string,
): void {
  const between = code.slice(open, firstStart);
  const newline = between.lastIndexOf('\n');
  output.appendLeft(
    firstStart,
    newline === -1 ? `${text}, ` : `${text},\n${between.slice(newline + 1)}`,
  );
}

function addToList(
  output: MagicString,
  code: string,
  config: ObjectExpression,
  call: string,
  key: Hook['key'],
): string | undefined {
  const property = config.properties.find(
    (entry): entry is ObjectProperty => entry.type === 'Property' && isKey(entry, key),
  );
  if (property === undefined) {
    const [first] = config.properties;
    if (first === undefined) output.appendLeft(config.start + 1, ` ${key}: [${call}] `);
    else insertFirst(output, code, config.start + 1, first.start, `${key}: [${call}]`);
    return undefined;
  }
  const value = unwrap(property.value);
  if (value.type !== 'ArrayExpression') return `its ${key} are not a plain array`;
  const plugins: ArrayExpression = value;
  const first = plugins.elements.find((element) => element !== null);
  if (first === undefined || first === null) output.appendLeft(plugins.start + 1, call);
  else insertFirst(output, code, plugins.start + 1, first.start, call);
  return undefined;
}

function addImport(output: MagicString, code: string, program: Program, hook: Hook): void {
  const imports = program.body.filter((statement) => statement.type === 'ImportDeclaration');
  const [first] = imports;
  const last = imports.at(-1);
  const quote = first === undefined ? "'" : (code[first.source.start] ?? "'");
  const semicolon = last === undefined || code[last.end - 1] === ';' ? ';' : '';
  const binding = hook.imported === 'default' ? 'guijam' : `{ ${hook.imported} }`;
  const line = `import ${binding} from ${quote}${hook.source}${quote}${semicolon}`;
  if (last === undefined) output.prepend(`${line}\n\n`);
  else output.appendLeft(last.end, `\n${line}`);
}

export function callsGuijam(
  code: string,
  filename = 'vite.config.ts',
  hook: Hook = VITE_HOOK,
): boolean {
  const parsed = parseSync(filename, code);
  if (parsed.errors.length > 0) return false;
  const local = guijamImportOf(parsed.program, hook);
  return local !== undefined && calls(parsed.program, local);
}

export function addGuijamPlugin(
  code: string,
  filename = 'vite.config.ts',
  hook: Hook = VITE_HOOK,
): EditOutcome {
  const parsed = parseSync(filename, code);
  const [error] = parsed.errors;
  if (error !== undefined)
    return { kind: 'manual', reason: `it could not be parsed (${error.message})` };
  const { program } = parsed;
  const local = guijamImportOf(program, hook);
  if (local !== undefined && calls(program, local)) return { kind: 'present' };

  const config = exportedConfig(program);
  if ('problem' in config) return { kind: 'manual', reason: config.problem };
  const output = new MagicString(code);
  const problem = addToList(output, code, config.node, `${local ?? 'guijam'}()`, hook.key);
  if (problem !== undefined) return { kind: 'manual', reason: problem };
  if (local === undefined) addImport(output, code, program, hook);

  const next = output.toString();
  if (!callsGuijam(next, filename, hook))
    return { kind: 'manual', reason: 'the edit could not be verified' };
  return { kind: 'added', code: next };
}

export function addAstroIntegration(code: string, filename = 'astro.config.mjs'): EditOutcome {
  return addGuijamPlugin(code, filename, ASTRO_HOOK);
}

function exportedExpression(program: Program): Expression | undefined {
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      const { declaration } = statement;
      return declaration.type === 'FunctionDeclaration' ||
        declaration.type === 'ClassDeclaration' ||
        declaration.type === 'TSInterfaceDeclaration'
        ? undefined
        : (declaration as Expression);
    }
    if (
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'AssignmentExpression' &&
      statement.expression.left.type === 'MemberExpression' &&
      statement.expression.left.object.type === 'Identifier' &&
      statement.expression.left.object.name === 'module' &&
      statement.expression.left.property.type === 'Identifier' &&
      statement.expression.left.property.name === 'exports'
    ) {
      return statement.expression.right;
    }
  }
  return undefined;
}

export function addWithGuijam(code: string, filename = 'next.config.mjs'): EditOutcome {
  const parsed = parseSync(filename, code);
  const [error] = parsed.errors;
  if (error !== undefined)
    return { kind: 'manual', reason: `it could not be parsed (${error.message})` };
  const { program } = parsed;
  const local = guijamImportOf(program, NEXT_HOOK);
  if (local !== undefined && calls(program, local)) return { kind: 'present' };
  const exported = exportedExpression(program);
  if (exported === undefined)
    return { kind: 'manual', reason: 'it has no exported config to wrap' };
  const name = local ?? 'withGuijam';
  const output = new MagicString(code);
  output.appendLeft(exported.start, `${name}(`);
  output.appendRight(exported.end, ')');
  if (local === undefined) {
    const esm = program.body.some(
      (statement) =>
        statement.type === 'ImportDeclaration' || statement.type === 'ExportDefaultDeclaration',
    );
    if (esm) addImport(output, code, program, NEXT_HOOK);
    else output.prepend(`const { withGuijam } = require('${NEXT_WRAPPER}');\n`);
  }
  const next = output.toString();
  const verified = parseSync(filename, next);
  const wrapped =
    guijamImportOf(verified.program, NEXT_HOOK) ??
    (next.includes(`require('${NEXT_WRAPPER}')`) ? 'withGuijam' : undefined);
  if (verified.errors.length > 0 || wrapped === undefined || !calls(verified.program, wrapped))
    return { kind: 'manual', reason: 'the edit could not be verified' };
  return { kind: 'added', code: next };
}

export function nextConfigSnippet(): string {
  return [
    `import { withGuijam } from '${NEXT_WRAPPER}';`,
    '',
    'export default withGuijam(yourNextConfig);',
  ].join('\n');
}

async function wireNext(project: Project): Promise<WireResult> {
  if (!supportsNext(project.frameworkVersion)) {
    return {
      status: 'unsupported',
      reason: `GUIJam needs Next.js 16.3 or newer (this app has ${project.frameworkVersion ?? 'no Next.js installed'}). Upgrade Next.js, then run init again.`,
    };
  }
  const file = project.configFile ?? join(project.root, 'next.config.mjs');
  if (project.configFile === undefined) {
    await writeFile(
      file,
      [
        `import { withGuijam } from '${NEXT_WRAPPER}';`,
        '',
        'export default withGuijam({});',
        '',
      ].join('\n'),
      { flag: 'wx' },
    );
    return { status: 'created', file };
  }
  const outcome = addWithGuijam(await readFile(file, 'utf8'), basename(file));
  if (outcome.kind === 'manual') {
    return {
      status: 'manual',
      file,
      reason: `${basename(file)} can't be edited safely: ${outcome.reason}.`,
      snippet: nextConfigSnippet(),
    };
  }
  if (outcome.kind === 'added') await writeFile(file, outcome.code);
  return { status: outcome.kind, file };
}

export function astroConfigSnippet(): string {
  return [
    `import guijam from '${ASTRO_INTEGRATION}';`,
    '',
    'export default defineConfig({',
    '  integrations: [guijam(), ...yourIntegrations],',
    '});',
  ].join('\n');
}

async function wireAstro(project: Project): Promise<WireResult> {
  const file = project.configFile ?? join(project.root, 'astro.config.mjs');
  if (project.configFile === undefined) {
    await writeFile(
      file,
      [
        "import { defineConfig } from 'astro/config';",
        `import guijam from '${ASTRO_INTEGRATION}';`,
        '',
        'export default defineConfig({',
        '  integrations: [guijam()],',
        '});',
        '',
      ].join('\n'),
      { flag: 'wx' },
    );
    return { status: 'created', file };
  }
  const outcome = addAstroIntegration(await readFile(file, 'utf8'), basename(file));
  if (outcome.kind === 'manual') {
    return {
      status: 'manual',
      file,
      reason: `${basename(file)} can't be edited safely: ${outcome.reason}.`,
      snippet: astroConfigSnippet(),
    };
  }
  if (outcome.kind === 'added') await writeFile(file, outcome.code);
  return { status: outcome.kind, file };
}

function modulesOf(config: ObjectExpression): Found<ArrayExpression> | undefined {
  const property = config.properties.find(
    (entry): entry is ObjectProperty => entry.type === 'Property' && isKey(entry, 'modules'),
  );
  if (property === undefined) return undefined;
  const value = unwrap(property.value);
  return value.type === 'ArrayExpression'
    ? { node: value }
    : { problem: 'its modules are not a plain array' };
}

function listsNuxtModule(modules: ArrayExpression): boolean {
  return modules.elements.some((element) => {
    if (element === null || element.type === 'SpreadElement') return false;
    const value = unwrap(element);
    if (value.type === 'Literal') return value.value === NUXT_MODULE;
    if (value.type === 'ArrayExpression') {
      const [name] = value.elements;
      return (
        name !== null && name !== undefined && name.type === 'Literal' && name.value === NUXT_MODULE
      );
    }
    return false;
  });
}

export function hasNuxtModule(code: string, filename = 'nuxt.config.ts'): boolean {
  const parsed = parseSync(filename, code);
  if (parsed.errors.length > 0) return false;
  const config = exportedConfig(parsed.program);
  if ('problem' in config) return false;
  const modules = modulesOf(config.node);
  return modules !== undefined && 'node' in modules && listsNuxtModule(modules.node);
}

export function addNuxtModule(code: string, filename = 'nuxt.config.ts'): EditOutcome {
  const parsed = parseSync(filename, code);
  const [error] = parsed.errors;
  if (error !== undefined)
    return { kind: 'manual', reason: `it could not be parsed (${error.message})` };
  const config = exportedConfig(parsed.program);
  if ('problem' in config) return { kind: 'manual', reason: config.problem };
  const output = new MagicString(code);
  const quote = code.includes('"') && !code.includes("'") ? '"' : "'";
  const entry = `${quote}${NUXT_MODULE}${quote}`;
  const modules = modulesOf(config.node);
  if (modules !== undefined && 'problem' in modules)
    return { kind: 'manual', reason: modules.problem };
  if (modules === undefined) {
    const [first] = config.node.properties;
    if (first === undefined) output.appendLeft(config.node.start + 1, ` modules: [${entry}] `);
    else insertFirst(output, code, config.node.start + 1, first.start, `modules: [${entry}]`);
  } else {
    if (listsNuxtModule(modules.node)) return { kind: 'present' };
    const first = modules.node.elements.find((element) => element !== null);
    if (first === undefined || first === null) output.appendLeft(modules.node.start + 1, entry);
    else insertFirst(output, code, modules.node.start + 1, first.start, entry);
  }
  const next = output.toString();
  if (!hasNuxtModule(next, filename))
    return { kind: 'manual', reason: 'the edit could not be verified' };
  return { kind: 'added', code: next };
}

export function nuxtConfigSnippet(): string {
  return [
    'export default defineNuxtConfig({',
    `  modules: ['${NUXT_MODULE}', ...yourModules],`,
    '});',
  ].join('\n');
}

export function viteConfigSnippet(): string {
  return [
    "import { guijam } from 'guijam/vite';",
    '',
    'export default defineConfig({',
    '  plugins: [guijam(), ...yourPlugins],',
    '});',
  ].join('\n');
}

function newViteConfig(): string {
  return [
    "import { guijam } from 'guijam/vite';",
    "import { defineConfig } from 'vite';",
    '',
    'export default defineConfig({',
    '  plugins: [guijam()],',
    '});',
    '',
  ].join('\n');
}

async function wireNuxt(project: Project): Promise<WireResult> {
  const file = project.configFile ?? join(project.root, 'nuxt.config.ts');
  if (project.configFile === undefined) {
    await writeFile(
      file,
      ['export default defineNuxtConfig({', `  modules: ['${NUXT_MODULE}'],`, '});', ''].join('\n'),
      { flag: 'wx' },
    );
    return { status: 'created', file };
  }
  const outcome = addNuxtModule(await readFile(file, 'utf8'), basename(file));
  if (outcome.kind === 'manual') {
    return {
      status: 'manual',
      file,
      reason: `${basename(file)} can't be edited safely: ${outcome.reason}.`,
      snippet: nuxtConfigSnippet(),
    };
  }
  if (outcome.kind === 'added') await writeFile(file, outcome.code);
  return { status: outcome.kind, file };
}

export async function wireProject(project: Project): Promise<WireResult> {
  const soon = COMING_SOON[project.framework];
  if (soon !== undefined) {
    return {
      status: 'unsupported',
      reason: `GUIJam doesn't plug into ${project.frameworkLabel} yet. ${soon}`,
    };
  }
  if (project.framework === 'nuxt') return wireNuxt(project);
  if (project.framework === 'astro') return wireAstro(project);
  if (project.framework === 'next') return wireNext(project);
  if (!VITE_FRAMEWORKS.has(project.framework)) {
    return {
      status: 'unsupported',
      reason: 'No Vite dev server found. GUIJam runs inside Vite for now.',
    };
  }
  if (project.configFile === undefined) {
    const file = join(project.root, project.typescript ? 'vite.config.ts' : 'vite.config.mjs');
    if (project.framework !== 'vite') {
      return {
        status: 'manual',
        file,
        reason: `${project.frameworkLabel} needs its own plugin in ${basename(file)}, and none was found.`,
        snippet: viteConfigSnippet(),
      };
    }
    await writeFile(file, newViteConfig(), { flag: 'wx' });
    return { status: 'created', file };
  }
  const file = project.configFile;
  const outcome = addGuijamPlugin(await readFile(file, 'utf8'), basename(file));
  if (outcome.kind === 'manual') {
    return {
      status: 'manual',
      file,
      reason: `${basename(file)} can't be edited safely: ${outcome.reason}.`,
      snippet: viteConfigSnippet(),
    };
  }
  if (outcome.kind === 'added') await writeFile(file, outcome.code);
  return { status: outcome.kind, file };
}

export async function isWired(project: Project): Promise<boolean> {
  if (project.configFile === undefined) return false;
  try {
    const code = await readFile(project.configFile, 'utf8');
    if (project.framework === 'nuxt') return hasNuxtModule(code, basename(project.configFile));
    if (project.framework === 'astro') {
      return callsGuijam(code, basename(project.configFile), ASTRO_HOOK);
    }
    if (project.framework === 'next') {
      return callsGuijam(code, basename(project.configFile), NEXT_HOOK);
    }
    return callsGuijam(code, basename(project.configFile));
  } catch {
    return false;
  }
}
