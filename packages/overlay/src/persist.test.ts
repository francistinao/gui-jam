import { describe, expect, it } from 'vitest';
import type { Job } from './controller';
import { parseSaved, serialize } from './persist';

const job = (id: string, status: 'idle' | 'running' | 'ready' = 'ready'): Job =>
  ({
    id,
    number: 1,
    target: { file: 'src/A.tsx', line: 3, column: 5, src: 'src/A.tsx:3:5', instances: 1 },
    also: [],
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
    ticket: null,
    page: 'http://localhost:5173/menu',
    sketchHidden: false,
    panelAt: null,
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

  it('keeps a linked ticket without its images, and gives an older save none', () => {
    const linked = {
      ...job('j1'),
      ticket: {
        ref: { provider: 'jira' as const, site: 'acme.atlassian.net', key: 'WEB-7' },
        summary: 'Make Subscribe blue',
        description: 'It should match the brand.',
        url: 'https://acme.atlassian.net/browse/WEB-7',
        transitions: [{ id: '31', name: 'In Review' }],
        images: [{ name: 'mock.png', mediaType: 'image/png' as const, base64: 'AAAA' }],
        before: [{ mediaType: 'image/jpeg' as const, base64: 'BBBB' }],
        transitionId: '31',
        screenshots: true,
      },
    };
    const saved = parseSaved(serialize([linked], null, true));
    expect(saved?.jobs[0]?.ticket).toEqual({ ...linked.ticket, images: [], before: [] });
    const older = JSON.parse(serialize([job('j2')], null, true));
    delete older.jobs[0].ticket;
    expect(parseSaved(JSON.stringify(older))?.jobs[0]?.ticket).toBeNull();
  });

  it('keeps the page a drawing was made on, and gives an older save none', () => {
    expect(parseSaved(serialize([job('j1')], null, true))?.jobs[0]?.page).toBe(
      'http://localhost:5173/menu',
    );
    const older = JSON.parse(serialize([job('j2')], null, true));
    delete older.jobs[0].page;
    expect(parseSaved(JSON.stringify(older))?.jobs[0]?.page).toBeNull();
  });

  it('keeps a hidden sketch and a moved panel through a reload', () => {
    const moved = { ...job('j1'), sketchHidden: true, panelAt: { left: 40, top: 220 } };
    const saved = parseSaved(serialize([moved], 'j1', true));
    expect(saved?.jobs[0]?.sketchHidden).toBe(true);
    expect(saved?.jobs[0]?.panelAt).toEqual({ left: 40, top: 220 });
  });

  it('shows the sketch and places the panel beside its drawing for a save made before either existed', () => {
    const older = JSON.parse(serialize([job('j1')], null, true));
    delete older.jobs[0].sketchHidden;
    delete older.jobs[0].panelAt;
    const saved = parseSaved(JSON.stringify(older));
    expect(saved?.jobs[0]?.sketchHidden).toBe(false);
    expect(saved?.jobs[0]?.panelAt).toBeNull();
  });

  it.each([
    ['a string', 'left'],
    ['missing top', { left: 4 }],
    ['text numbers', { left: '4', top: '5' }],
    ['infinite', { left: 4, top: Number.POSITIVE_INFINITY }],
    ['null', null],
  ])('drops a panel spot that is %s', (_label, panelAt) => {
    const text = JSON.stringify({
      version: 1,
      focus: null,
      jobs: [{ ...job('j1'), panelAt, sketchHidden: 'yes' }],
    });
    const saved = parseSaved(text);
    expect(saved?.jobs[0]?.panelAt).toBeNull();
    expect(saved?.jobs[0]?.sketchHidden).toBe(false);
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
    const sketch = { strokes, undone: [], bounds, element };
    const drawn = { ...job('j1', 'idle'), strokes, sketch };

    const text = serialize([drawn], 'j1', true);
    const saved = parseSaved(text);

    expect(saved?.focus).toBe('j1');
    expect(saved?.jobs[0]?.sketch).toEqual(sketch);
    expect(saved?.jobs[0]?.strokes).toEqual(strokes);
    expect(text.length).toBeLessThan(JSON.stringify(strokes).length * 1.05);
  });

  it('keeps the strokes that can be redone', () => {
    const kept = [{ x: 1, y: 2 }];
    const undone = [[{ x: 5, y: 6 }], [{ x: 7, y: 8 }]];
    const sketch = { strokes: [kept], undone, bounds: { left: 1, top: 2, width: 0, height: 0 } };
    const saved = parseSaved(serialize([{ ...job('j1', 'idle'), sketch }], 'j1', true));
    expect(saved?.jobs[0]?.sketch).toEqual(sketch);
    expect(saved?.jobs[0]?.strokes).toEqual([kept]);
  });

  it('gives a sketch saved before undo existed an empty redo list', () => {
    const strokes = [[{ x: 1, y: 2 }]];
    const bounds = { left: 1, top: 2, width: 0, height: 0 };
    const text = JSON.stringify({
      version: 1,
      focus: 'j1',
      jobs: [{ ...job('j1', 'idle'), strokes: [], sketch: { strokes, bounds } }],
    });
    expect(parseSaved(text)?.jobs[0]?.sketch).toEqual({ strokes, undone: [], bounds });
  });

  it('keeps the other selected components, and gives an older save none', () => {
    const card = {
      file: 'src/Card.tsx',
      line: 8,
      column: 3,
      src: 'src/Card.tsx:8:3',
      instances: 3,
    };
    const saved = parseSaved(serialize([{ ...job('j1', 'idle'), also: [card] }], 'j1', true));
    expect(saved?.jobs[0]?.also).toEqual([card]);

    const { also: _, ...older } = job('j2', 'idle');
    const text = JSON.stringify({ version: 1, focus: null, jobs: [older] });
    expect(parseSaved(text)?.jobs[0]?.also).toEqual([]);
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
