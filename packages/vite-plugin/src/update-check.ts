import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface DistTags {
  latest?: string;
  next?: string;
}

export type FetchTags = () => Promise<DistTags>;

export interface UpdateNoticeOptions {
  root: string;
  version: string;
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: number;
  fetchTags?: FetchTags;
}

interface Version {
  core: [number, number, number];
  pre: string[];
}

const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/guijam/dist-tags';
const TIMEOUT_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC = /^\d+$/;

function parse(version: string): Version | undefined {
  const match = SEMVER.exec(version.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

function comparePart(a: string, b: string): number {
  if (NUMERIC.test(a) && NUMERIC.test(b)) return Number(a) - Number(b);
  if (NUMERIC.test(a) !== NUMERIC.test(b)) return NUMERIC.test(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a: Version, b: Version): number {
  const core = [a.core[0] - b.core[0], a.core[1] - b.core[1], a.core[2] - b.core[2]].find(
    (difference) => difference !== 0,
  );
  if (core !== undefined) return core;
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (const [index, part] of a.pre.entries()) {
    const other = b.pre[index];
    if (other === undefined) return 1;
    const order = comparePart(part, other);
    if (order !== 0) return order;
  }
  return a.pre.length - b.pre.length;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  return a !== undefined && b !== undefined && compare(a, b) > 0;
}

export function newestFor(current: string, tags: DistTags): string | undefined {
  const channels = current.includes('-') ? [tags.latest, tags.next] : [tags.latest];
  let newest: string | undefined;
  for (const tag of channels) if (tag && isNewer(tag, newest ?? current)) newest = tag;
  return newest;
}

export function checksOff(version: string, env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI;
  return (
    version === '0.0.0' ||
    Boolean(env.GUIJAM_NO_UPDATE_CHECK) ||
    (Boolean(ci) && ci !== 'false' && ci !== '0')
  );
}

export function updateMessage(current: string, newest: string): string {
  return `guijam ${newest} is available (you have ${current}). Run npx guijam update to install it.`;
}

function tagsOf(value: unknown): DistTags {
  if (typeof value !== 'object' || value === null) return {};
  const { latest, next } = value as Record<string, unknown>;
  return {
    ...(typeof latest === 'string' ? { latest } : {}),
    ...(typeof next === 'string' ? { next } : {}),
  };
}

export async function fetchDistTags(): Promise<DistTags> {
  const response = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`npm answered ${response.status}`);
  return tagsOf(await response.json());
}

async function cachedTags(file: string, now: number): Promise<DistTags | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const { checkedAt, tags } = value as Record<string, unknown>;
    if (typeof checkedAt !== 'number' || Math.abs(now - checkedAt) >= DAY_MS) return undefined;
    return tagsOf(tags);
  } catch {
    return undefined;
  }
}

async function newestTags(root: string, now: number, fetchTags: FetchTags): Promise<DistTags> {
  const file = join(root, '.guijam', 'update-check.json');
  const cached = await cachedTags(file, now);
  if (cached) return cached;
  const tags = await fetchTags();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ checkedAt: now, tags }));
  return tags;
}

export async function noticeUpdate(options: UpdateNoticeOptions): Promise<void> {
  const { root, version, log, env = process.env, now = Date.now() } = options;
  if (checksOff(version, env)) return;
  const fetchTags = options.fetchTags ?? fetchDistTags;
  const tags = await newestTags(root, now, fetchTags).catch(() => undefined);
  const newest = tags && newestFor(version, tags);
  if (newest) log(`[guijam] ${updateMessage(version, newest)}`);
}
