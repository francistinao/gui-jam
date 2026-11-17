import type { Job } from './controller';

export const JOBS_KEY = 'guijam:jobs';
const VERSION = 1;
const STATUSES = ['idle', 'running', 'ready'];

export interface Saved {
  jobs: Job[];
  focus: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJob(value: unknown): value is Job {
  if (!isRecord(value) || !isRecord(value.target) || !isRecord(value.generation)) return false;
  const { target, generation } = value;
  return (
    typeof value.id === 'string' &&
    typeof value.number === 'number' &&
    Array.isArray(value.strokes) &&
    isRecord(value.anchor) &&
    typeof target.file === 'string' &&
    typeof target.src === 'string' &&
    typeof target.line === 'number' &&
    typeof target.column === 'number' &&
    STATUSES.includes(String(generation.status)) &&
    typeof generation.prompt === 'string' &&
    Array.isArray(generation.variants) &&
    Array.isArray(generation.steps) &&
    (generation.runId === null || typeof generation.runId === 'string')
  );
}

export function serialize(jobs: readonly Job[], focus: string | null, images: boolean): string {
  return JSON.stringify({
    version: VERSION,
    focus,
    jobs: jobs.map((job) => ({
      ...job,
      installing: false,
      attachments: images ? job.attachments : [],
    })),
  });
}

export function parseSaved(text: string | null): Saved | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.jobs)) return null;
  const jobs = value.jobs.filter(isJob).map((job) => ({
    ...job,
    attachments: Array.isArray(job.attachments) ? job.attachments : [],
    attachError: null,
    installing: false,
    installError: typeof job.installError === 'string' ? job.installError : null,
  }));
  if (jobs.length === 0) return null;
  const focus =
    typeof value.focus === 'string' && jobs.some((job) => job.id === value.focus)
      ? value.focus
      : null;
  return { jobs, focus };
}

function write(text: string): boolean {
  try {
    sessionStorage.setItem(JOBS_KEY, text);
    return true;
  } catch {
    return false;
  }
}

export function save(jobs: readonly Job[], focus: string | null): void {
  if (jobs.length === 0) {
    try {
      sessionStorage.removeItem(JOBS_KEY);
    } catch {
      return;
    }
    return;
  }
  if (!write(serialize(jobs, focus, true))) write(serialize(jobs, focus, false));
}

export function load(): Saved | null {
  try {
    return parseSaved(sessionStorage.getItem(JOBS_KEY));
  } catch {
    return null;
  }
}
