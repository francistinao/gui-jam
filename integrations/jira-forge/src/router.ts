import {
  bulletList,
  codeBlock,
  diffText,
  doc,
  heading,
  mention,
  paragraph,
  plainText,
  text,
} from './adf';
import type {
  BridgeCreate,
  BridgeErrorCode,
  BridgeImage,
  BridgePosted,
  BridgeResult,
  BridgeStart,
  BridgeTicket,
  BridgeTicketPage,
  BridgeWhoami,
  SketchImage,
} from './generated/bridge';
import { type Jira, JiraError, type Permission, PermissionCheckUnavailable } from './jira';
import { type AllowedProject, findPairing, type Pairing, revokeHash, touch } from './pairing';
import type { Store } from './store';

export interface BridgeRequest {
  method: string;
  path?: string;
  userPath?: string;
  headers: Record<string, string[] | undefined>;
  queryParameters?: Record<string, string[] | undefined>;
  body?: string;
}

export interface BridgeResponse {
  statusCode: number;
  headers: Record<string, string[]>;
  body: string;
}

export interface Deps {
  jira: Jira;
  store: Store;
  now(): number;
}

export interface GuijamProperty {
  status: 'queued' | 'in_progress' | 'applied' | 'reverted';
  file?: string;
  src?: string;
  pageUrl?: string;
  journalId?: string;
  appliedAt?: string;
  by?: string;
}

export interface ResultRecord {
  journalId: string;
  accountId: string;
  appliedAt: string;
  summary: string;
  agent: string;
  src: string;
  pageUrl: string;
  files: string[];
  diff: string;
  before: string[];
  after: string[];
  patch?: string;
  status: 'applied' | 'reverted';
}

export const MAX_BODY = 5_000_000;
const MAX_IMAGE = 3_000_000;
const RATE_PER_MINUTE = 120;
const SEARCH_MAX = 20;
const DIFF_LINES = 200;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const KEY = /^[A-Z][A-Z0-9_]*-[0-9]+$/;
const PROJECT = /^[A-Z][A-Z0-9_]*$/;
const TEXT_SPECIAL = /[+\-&|!(){}[\]^~*?\\:"']/g;
const POST: Permission[] = ['ADD_COMMENTS', 'CREATE_ATTACHMENTS', 'EDIT_ISSUES'];

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (status: number, code: BridgeErrorCode, message: string) =>
  new Refusal(status, code, message);

function reply(statusCode: number, value: unknown): BridgeResponse {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(value),
  };
}

const ok = (data: unknown) => reply(200, { ok: true, data });

function header(request: BridgeRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === wanted) return values?.[0];
  }
  return undefined;
}

function query(request: BridgeRequest, name: string): string {
  return request.queryParameters?.[name]?.[0] ?? '';
}

export function routeOf(request: BridgeRequest): string {
  if (typeof request.userPath === 'string' && request.userPath) return request.userPath;
  const path = request.path ?? '';
  const at = path.indexOf('/v1/');
  return at >= 0 ? path.slice(at) : path;
}

function body<T>(request: BridgeRequest): T {
  try {
    return JSON.parse(request.body ?? '') as T;
  } catch {
    throw refuse(400, 'INVALID_REQUEST', 'The request body is not JSON.');
  }
}

function site(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function allowedProject(pairing: Pairing, projectId: string): AllowedProject | undefined {
  return pairing.projects.find((project) => project.id === projectId);
}

function projectAllows(project: AllowedProject, permission: Permission): boolean {
  if (permission === 'BROWSE_PROJECTS') return true;
  if (permission === 'CREATE_ISSUES') return project.create;
  return project.post;
}

async function permitted(
  deps: Deps,
  pairing: Pairing,
  issues: { id: string; projectId: string }[],
  permissions: Permission[],
): Promise<Set<string>> {
  const inProjects = issues.filter((issue) => allowedProject(pairing, issue.projectId));
  if (inProjects.length === 0) return new Set();
  try {
    const granted = await deps.jira.permissions(
      pairing.accountId,
      { issues: inProjects.map((issue) => issue.id) },
      permissions,
    );
    return new Set(
      inProjects
        .filter((issue) =>
          permissions.every((permission) => granted.get(permission)?.issues.has(issue.id)),
        )
        .map((issue) => issue.id),
    );
  } catch (error) {
    if (!(error instanceof PermissionCheckUnavailable)) throw error;
    return new Set(
      inProjects
        .filter((issue) => {
          const project = allowedProject(pairing, issue.projectId);
          return project && permissions.every((permission) => projectAllows(project, permission));
        })
        .map((issue) => issue.id),
    );
  }
}

async function guardedIssue(deps: Deps, pairing: Pairing, key: string, permissions: Permission[]) {
  if (!KEY.test(key)) throw refuse(400, 'INVALID_REQUEST', `${key} isn't a ticket key.`);
  const issue = await deps.jira.issue(key);
  if (!issue) throw refuse(404, 'NOT_FOUND', `${key} doesn't exist, or you can't see it.`);
  const allowed = await permitted(deps, pairing, [issue], ['BROWSE_PROJECTS']);
  if (!allowed.has(issue.id))
    throw refuse(404, 'NOT_FOUND', `${key} doesn't exist, or you can't see it.`);
  if (permissions.length > 0) {
    const writable = await permitted(deps, pairing, [issue], permissions);
    if (!writable.has(issue.id)) {
      throw refuse(403, 'FORBIDDEN', `You don't have permission to update ${key}.`);
    }
  }
  return issue;
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function ticketJql(pairing: Pairing, preset: string, words: string): string {
  const projects = pairing.projects.map((project) => project.id).join(', ');
  const trimmed = words.trim();
  const clauses = [`project in (${projects})`];
  if (KEY.test(trimmed.toUpperCase())) {
    clauses.push(`key = ${quoted(trimmed.toUpperCase())}`);
  } else {
    clauses.push(
      preset === 'queued'
        ? 'guijamStatus = "queued"'
        : `assignee = ${quoted(pairing.accountId)} AND statusCategory != Done`,
    );
    const cleaned = trimmed.replace(TEXT_SPECIAL, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (cleaned) clauses.push(`text ~ ${quoted(`${cleaned}*`)}`);
  }
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

async function whoami(deps: Deps, pairing: Pairing): Promise<BridgeWhoami> {
  const baseUrl = await deps.jira.baseUrl();
  return {
    accountId: pairing.accountId,
    displayName: await deps.jira.displayName(pairing.accountId),
    site: site(baseUrl),
    url: baseUrl,
    projects: pairing.projects.map((project) => ({ key: project.key, name: project.name })),
  };
}

async function tickets(
  deps: Deps,
  pairing: Pairing,
  request: BridgeRequest,
): Promise<BridgeTicketPage> {
  if (pairing.projects.length === 0) return { tickets: [] };
  const preset = query(request, 'preset') === 'queued' ? 'queued' : 'assigned';
  const rows = await deps.jira.search(ticketJql(pairing, preset, query(request, 'q')), SEARCH_MAX);
  const allowed = await permitted(deps, pairing, rows, ['BROWSE_PROJECTS']);
  return {
    tickets: rows
      .filter((row) => allowed.has(row.id))
      .map((row) => ({ key: row.key, summary: row.summary, status: row.status, type: row.type })),
  };
}

async function ticket(deps: Deps, pairing: Pairing, key: string): Promise<BridgeTicket> {
  const issue = await guardedIssue(deps, pairing, key, []);
  return {
    key: issue.key,
    summary: issue.summary,
    description: plainText(issue.description),
    status: issue.status,
    attachments: issue.attachments,
    transitions: issue.transitions,
  };
}

async function attachment(
  deps: Deps,
  pairing: Pairing,
  key: string,
  id: string,
): Promise<BridgeImage> {
  const issue = await guardedIssue(deps, pairing, key, []);
  const listed = issue.attachments.find((entry) => entry.id === id);
  if (!listed || !IMAGE_TYPES.has(listed.mimeType)) {
    throw refuse(404, 'NOT_FOUND', `${key} has no such image.`);
  }
  if (listed.size > MAX_IMAGE) throw refuse(413, 'TOO_LARGE', `${listed.filename} is too large.`);
  const content = await deps.jira.attachment(id);
  if (!content) throw refuse(404, 'NOT_FOUND', `${key} has no such image.`);
  return {
    mediaType: listed.mimeType as BridgeImage['mediaType'],
    base64: Buffer.from(content.bytes).toString('base64'),
  };
}

async function start(deps: Deps, pairing: Pairing, key: string, request: BridgeRequest) {
  const started = body<BridgeStart>(request);
  await guardedIssue(deps, pairing, key, ['EDIT_ISSUES']);
  const current = await deps.jira.property<GuijamProperty>(key);
  if (current?.status === 'applied') return {};
  await deps.jira.setProperty(key, {
    ...current,
    status: 'in_progress',
    pageUrl: String(started.pageUrl ?? '').slice(0, 2000),
    src: String(started.src ?? '').slice(0, 1000),
    by: pairing.accountId,
  } satisfies GuijamProperty);
  return {};
}

function fileOf(src: string): string {
  const match = /^(.+):(\d+):\d+$/.exec(src);
  return match ? `${match[1]}:${match[2]}` : src;
}

function shots(images: SketchImage[] | undefined, prefix: string) {
  return (images ?? []).slice(0, 2).map((image, index) => ({
    name: `${prefix}-${index + 1}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`,
    image,
  }));
}

function resultComment(
  accountId: string,
  result: BridgeResult,
  diff: string,
  uploaded: string[],
  patchName?: string,
) {
  const content = [
    heading(3, 'GUIJam applied a change'),
    paragraph(mention(accountId), text(` applied this with GUIJam (${result.agent}).`)),
    paragraph(text('Element: '), text(fileOf(result.src), 'code')),
    bulletList(result.files.slice(0, 20).map((file) => [text(file, 'code')])),
  ];
  if (diff) content.push(codeBlock(diff, 'diff'));
  if (patchName) content.push(paragraph(text(`The full diff is attached as ${patchName}.`)));
  if (uploaded.length > 0) {
    content.push(paragraph(text(`Screenshots attached: ${uploaded.join(', ')}.`)));
  }
  content.push(paragraph(text('Undo in GUIJam reverts it, and this ticket will say so.', 'em')));
  return doc(...content);
}

async function result(deps: Deps, pairing: Pairing, key: string, request: BridgeRequest) {
  const posted = body<BridgeResult>(request);
  if (!posted.journalId || typeof posted.journalId !== 'string' || posted.journalId.length > 64) {
    throw refuse(400, 'INVALID_REQUEST', 'The result has no change id.');
  }
  const doneKey = `posted:${posted.journalId}`;
  const done = await deps.store.get<BridgePosted>(doneKey);
  if (done) return done;
  const permissions: Permission[] = posted.transitionId ? [...POST, 'TRANSITION_ISSUES'] : POST;
  const issue = await guardedIssue(deps, pairing, key, permissions);
  const uploaded: { name: string; id: string; side: 'before' | 'after' }[] = [];
  for (const [side, list] of [
    ['before', shots(posted.before, 'guijam-before')],
    ['after', shots(posted.after, 'guijam-after')],
  ] as const) {
    for (const shot of list) {
      const bytes = Buffer.from(shot.image.base64, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_IMAGE) continue;
      const id = await deps.jira.upload(key, shot.name, shot.image.mediaType, bytes);
      uploaded.push({ name: shot.name, id, side });
    }
  }
  const changes = posted.changes ?? [];
  const inline = changes.reduce(
    (lines, change) => lines + change.before.length + change.after.length,
    0,
  );
  const diff = inline <= DIFF_LINES ? diffText(changes) : '';
  let patchName: string | undefined;
  let patchId: string | undefined;
  if (posted.patch && (inline > DIFF_LINES || changes.length === 0)) {
    patchName = `guijam-${posted.journalId}.patch`;
    patchId = await deps.jira.upload(key, patchName, 'text/plain', Buffer.from(posted.patch));
  }
  const appliedAt = new Date(deps.now()).toISOString();
  await deps.jira.comment(
    key,
    resultComment(
      pairing.accountId,
      posted,
      diff,
      uploaded.map((entry) => entry.name),
      patchName,
    ),
  );
  await deps.jira.setProperty(key, {
    status: 'applied',
    file: fileOf(posted.src).slice(0, 255),
    src: posted.src.slice(0, 1000),
    pageUrl: posted.pageUrl.slice(0, 2000),
    journalId: posted.journalId,
    appliedAt,
    by: pairing.accountId,
  } satisfies GuijamProperty);
  const record: ResultRecord = {
    journalId: posted.journalId,
    accountId: pairing.accountId,
    appliedAt,
    summary: posted.summary.slice(0, 500),
    agent: posted.agent.slice(0, 200),
    src: posted.src.slice(0, 1000),
    pageUrl: posted.pageUrl.slice(0, 2000),
    files: posted.files.slice(0, 50),
    diff: diff.slice(0, 100_000),
    before: uploaded.filter((entry) => entry.side === 'before').map((entry) => entry.id),
    after: uploaded.filter((entry) => entry.side === 'after').map((entry) => entry.id),
    ...(patchId ? { patch: patchId } : {}),
    status: 'applied',
  };
  await deps.store.set(`result:${issue.id}`, record);
  if (posted.transitionId) {
    const known = issue.transitions.some((transition) => transition.id === posted.transitionId);
    if (known) await deps.jira.transition(key, posted.transitionId);
  }
  const answer: BridgePosted = {
    key,
    url: `${(await deps.jira.baseUrl()).replace(/\/$/, '')}/browse/${key}`,
  };
  await deps.store.set(doneKey, answer, 7 * 24 * 60 * 60);
  return answer;
}

async function reverted(deps: Deps, pairing: Pairing, key: string, request: BridgeRequest) {
  const { journalId } = body<{ journalId?: string }>(request);
  const issue = await guardedIssue(deps, pairing, key, ['ADD_COMMENTS', 'EDIT_ISSUES']);
  const record = await deps.store.get<ResultRecord>(`result:${issue.id}`);
  if (!record || record.journalId !== journalId || record.status === 'reverted') return {};
  await deps.store.set(`result:${issue.id}`, { ...record, status: 'reverted' });
  const current = await deps.jira.property<GuijamProperty>(key);
  await deps.jira.setProperty(key, { ...current, status: 'reverted' } satisfies GuijamProperty);
  await deps.jira.comment(
    key,
    doc(paragraph(mention(pairing.accountId), text(' undid the GUIJam change in their project.'))),
  );
  return {};
}

async function create(deps: Deps, pairing: Pairing, request: BridgeRequest): Promise<BridgePosted> {
  const report = body<BridgeCreate>(request);
  if (!PROJECT.test(String(report.project)) || !report.summary?.trim()) {
    throw refuse(400, 'INVALID_REQUEST', 'A project and a summary are needed.');
  }
  const project = pairing.projects.find((entry) => entry.key === report.project);
  if (!project) throw refuse(403, 'FORBIDDEN', `You can't create tickets in ${report.project}.`);
  try {
    const granted = await deps.jira.permissions(pairing.accountId, { projects: [project.id] }, [
      'CREATE_ISSUES',
      'CREATE_ATTACHMENTS',
    ]);
    const can = ['CREATE_ISSUES', 'CREATE_ATTACHMENTS'].every((permission) =>
      granted.get(permission as Permission)?.projects.has(project.id),
    );
    if (!can) throw refuse(403, 'FORBIDDEN', `You can't create tickets in ${report.project}.`);
  } catch (error) {
    if (!(error instanceof PermissionCheckUnavailable)) throw error;
    if (!project.create) {
      throw refuse(403, 'FORBIDDEN', `You can't create tickets in ${report.project}.`);
    }
  }
  const description = doc(
    ...(report.description?.trim()
      ? report.description
          .trim()
          .split(/\n{2,}/)
          .map((part) => paragraph(text(part)))
      : []),
    paragraph(text('Reported from GUIJam by '), mention(pairing.accountId), text('.')),
    paragraph(text('Element: '), text(fileOf(String(report.src ?? '')), 'code')),
    paragraph(text('Page: '), text(String(report.pageUrl ?? ''), 'code')),
  );
  const created = await deps.jira.createIssue(
    project.key,
    report.summary.trim().slice(0, 255),
    description,
  );
  const image = report.image;
  if (image?.base64) {
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.length > 0 && bytes.length <= MAX_IMAGE) {
      await deps.jira.upload(
        created.key,
        `guijam-element.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`,
        image.mediaType,
        bytes,
      );
    }
  }
  await deps.jira.setProperty(created.key, {
    status: 'queued',
    src: String(report.src ?? '').slice(0, 1000),
    file: fileOf(String(report.src ?? '')).slice(0, 255),
    pageUrl: String(report.pageUrl ?? '').slice(0, 2000),
    by: pairing.accountId,
  } satisfies GuijamProperty);
  return {
    key: created.key,
    url: `${(await deps.jira.baseUrl()).replace(/\/$/, '')}/browse/${created.key}`,
  };
}

async function rateLimited(deps: Deps, hash: string): Promise<boolean> {
  const minute = Math.floor(deps.now() / 60_000);
  const key = `rate:${hash.slice(0, 16)}:${minute}`;
  const used = (await deps.store.get<number>(key)) ?? 0;
  if (used >= RATE_PER_MINUTE) return true;
  await deps.store.set(key, used + 1, 120);
  return false;
}

async function dispatch(
  deps: Deps,
  request: BridgeRequest,
  hash: string,
  pairing: Pairing,
): Promise<unknown> {
  const path = routeOf(request);
  const method = request.method.toUpperCase();
  if (method === 'GET' && path === '/v1/whoami') return whoami(deps, pairing);
  if (method === 'POST' && path === '/v1/unpair') {
    await revokeHash(deps.store, hash, pairing);
    return {};
  }
  if (method === 'GET' && path === '/v1/tickets') return tickets(deps, pairing, request);
  if (method === 'POST' && path === '/v1/tickets') return create(deps, pairing, request);
  const attachmentMatch = /^\/v1\/tickets\/([^/]+)\/attachments\/(\d+)$/.exec(path);
  if (method === 'GET' && attachmentMatch?.[1] && attachmentMatch[2]) {
    return attachment(deps, pairing, attachmentMatch[1], attachmentMatch[2]);
  }
  const ticketMatch = /^\/v1\/tickets\/([^/]+)(?:\/(start|result|reverted))?$/.exec(path);
  const key = ticketMatch?.[1];
  if (key) {
    const action = ticketMatch?.[2];
    if (method === 'GET' && !action) return ticket(deps, pairing, key);
    if (method === 'POST' && action === 'start') return start(deps, pairing, key, request);
    if (method === 'POST' && action === 'result') return result(deps, pairing, key, request);
    if (method === 'POST' && action === 'reverted') return reverted(deps, pairing, key, request);
  }
  throw refuse(404, 'NOT_FOUND', `There's no ${method} ${path}.`);
}

export async function handle(request: BridgeRequest, deps: Deps): Promise<BridgeResponse> {
  try {
    if ((request.body?.length ?? 0) > MAX_BODY) {
      throw refuse(413, 'TOO_LARGE', 'The request is larger than 5 MB.');
    }
    const authorization = header(request, 'authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const found = token ? await findPairing(deps.store, token) : undefined;
    if (!found) throw refuse(401, 'UNAUTHORIZED', 'This GUIJam pairing is not valid.');
    if (await rateLimited(deps, found.hash)) {
      throw refuse(429, 'RATE_LIMITED', 'Too many requests. Wait a minute.');
    }
    await touch(deps.store, found.hash, found.pairing, deps.now());
    return ok(await dispatch(deps, request, found.hash, found.pairing));
  } catch (error) {
    if (error instanceof Refusal) {
      return reply(error.status, { ok: false, code: error.code, message: error.message });
    }
    if (error instanceof JiraError) {
      const status = error.status === 404 ? 404 : error.status === 403 ? 403 : 502;
      const code: BridgeErrorCode =
        status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'JIRA_ERROR';
      return reply(status, { ok: false, code, message: error.message });
    }
    return reply(500, { ok: false, code: 'INTERNAL', message: 'The GUIJam app failed.' });
  }
}
