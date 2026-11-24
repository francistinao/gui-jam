import type { Job } from './controller';
import { isPanelSpot } from './model';
import { storedTicket } from './tracker';

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
      strokes: job.sketch ? [] : job.strokes,
      installing: false,
      attachments: images ? job.attachments : [],
      ticket: storedTicket(job.ticket),
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
    sketch: isRecord(job.sketch)
      ? { ...job.sketch, undone: Array.isArray(job.sketch.undone) ? job.sketch.undone : [] }
      : job.sketch,
    strokes:
      isRecord(job.sketch) && Array.isArray(job.sketch.strokes) ? job.sketch.strokes : job.strokes,
    also: Array.isArray(job.also) ? job.also : [],
    attachments: Array.isArray(job.attachments) ? job.attachments : [],
    attachError: null,
    installing: false,
    installError: typeof job.installError === 'string' ? job.installError : null,
    ticket: isRecord(job.ticket) && isRecord(job.ticket.ref) ? job.ticket : null,
    page: typeof job.page === 'string' ? job.page : null,
    sketchHidden: job.sketchHidden === true,
    panelAt: isPanelSpot(job.panelAt) ? job.panelAt : null,
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

function forget(): void {
  try {
    sessionStorage.removeItem(JOBS_KEY);
  } catch {
    return;
  }
}

export function save(jobs: readonly Job[], focus: string | null): void {
  if (jobs.length === 0) {
    forget();
    return;
  }
  if (!write(serialize(jobs, focus, true)) && !write(serialize(jobs, focus, false))) forget();
}

export function load(): Saved | null {
  try {
    return parseSaved(sessionStorage.getItem(JOBS_KEY));
  } catch {
    return null;
  }
}
