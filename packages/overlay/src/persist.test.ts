import { describe, expect, it } from 'vitest';
import type { Job } from './controller';
import { parseSaved, serialize } from './persist';

const job = (id: string, status: 'idle' | 'running' | 'ready' = 'ready'): Job =>
  ({
    id,
    number: 1,
    target: { file: 'src/A.tsx', line: 3, column: 5, src: 'src/A.tsx:3:5', instances: 1 },
    anchor: { left: 1, top: 2, width: 3, height: 4 },
    strokes: [],
    sketch: null,
    generation: {
      prompt: 'make it pop',
      status,
      runId: status === 'idle' ? null : 'run-1',
      steps: [],
      variants: [],
      active: 0,
      dropped: [],
      route: null,
      elapsedMs: 0,
      answer: null,
      error: null,
      notes: [],
      startedAt: null,
      stepSince: null,
      timeoutMs: null,
      expectedMs: null,
      waiting: 0,
    },
    previewed: true,
    attachments: [
      { id: 'a', name: 'mood.png', mediaType: 'image/png', base64: 'AAAA', width: 1, height: 1 },
    ],
    attachError: 'old problem',
    installing: true,
    installError: null,
  }) as Job;

describe('persisted jobs', () => {
  it('round-trips jobs and focus, never restoring an install in progress', () => {
    const saved = parseSaved(serialize([job('j1'), job('j2', 'running')], 'j2', true));
    expect(saved?.focus).toBe('j2');
    expect(saved?.jobs.map((entry) => entry.id)).toEqual(['j1', 'j2']);
    expect(saved?.jobs[0]?.installing).toBe(false);
    expect(saved?.jobs[0]?.attachError).toBeNull();
    expect(saved?.jobs[0]?.attachments).toHaveLength(1);
    expect(saved?.jobs[1]?.generation.status).toBe('running');
  });

  it('can leave the images out when storage is short', () => {
    const saved = parseSaved(serialize([job('j1')], null, false));
    expect(saved?.jobs[0]?.attachments).toEqual([]);
  });

  it.each([
    ['nothing', null],
    ['empty', ''],
    ['not json', '{"version":1,'],
    ['another version', JSON.stringify({ version: 2, jobs: [job('j1')], focus: null })],
    ['no jobs list', JSON.stringify({ version: 1, jobs: 'x', focus: null })],
    ['only broken jobs', JSON.stringify({ version: 1, jobs: [{ id: 3 }, null, 'x'], focus: null })],
  ])('ignores %s', (_label, text) => {
    expect(parseSaved(text)).toBeNull();
  });

  it('keeps a heavy sketch over a selected element through a save and a reload', () => {
    const element = { left: 100, top: 200, width: 140, height: 48 };
    const strokes = Array.from({ length: 300 }, (_, stroke) =>
      Array.from({ length: 200 }, (_, point) => ({
        x: 100 + ((stroke * 7 + point) % 400) + 0.25,
        y: 200 + ((stroke * 3 + point * 2) % 300) + 0.5,
      })),
    );
    const bounds = { left: 100.25, top: 200.5, width: 399, height: 299 };
    const drawn = { ...job('j1', 'idle'), strokes, sketch: { strokes, bounds, element } };

    const text = serialize([drawn], 'j1', true);
    const saved = parseSaved(text);

    expect(saved?.focus).toBe('j1');
    expect(saved?.jobs[0]?.sketch).toEqual({ strokes, bounds, element });
    expect(saved?.jobs[0]?.strokes).toEqual(strokes);
    expect(text.length).toBeLessThan(JSON.stringify(strokes).length * 1.05);
  });

  it('saves the strokes of a circled element, which has no sketch', () => {
    const circle = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const saved = parseSaved(serialize([{ ...job('j1'), strokes: [circle] }], null, true));
    expect(saved?.jobs[0]?.strokes).toEqual([circle]);
  });

  it('keeps the good jobs, drops broken ones, and forgets a focus that is gone', () => {
    const broken = { ...job('j2'), generation: { ...job('j2').generation, status: 'weird' } };
    const text = JSON.stringify({
      version: 1,
      jobs: [job('j1'), broken, { id: 'j3' }],
      focus: 'j3',
    });
    const saved = parseSaved(text);
    expect(saved?.jobs.map((entry) => entry.id)).toEqual(['j1']);
    expect(saved?.focus).toBeNull();
  });
});
