import { describe, expect, it } from 'vitest';
import {
  checkWidgetRequest,
  errorReply,
  generationRunId,
  replyWindowMs,
  requestId,
  requestRunId,
  splitPage,
  terminalLine,
} from './relay.js';

describe('checkWidgetRequest', () => {
  it('admits a widget request with an id and a payload', () => {
    const request = {
      type: 'element.inspect',
      id: 'w1',
      payload: { file: 'src/A.tsx', line: 3, column: 5 },
    };

    expect(checkWidgetRequest(request)).toEqual({ ok: true, message: request });
  });

  it.each([
    'tracker.status',
    'tracker.search',
    'tracker.ticket',
    'tracker.start',
    'tracker.post',
    'tracker.report',
  ])('admits the Jira request %s', (type) => {
    const request = { type, id: 'w1', payload: {} };
    expect(checkWidgetRequest(request)).toEqual({ ok: true, message: request });
  });

  it.each([
    [
      'a daemon-only message',
      { type: 'overlay.set', id: 'w1', payload: { file: 'a', content: '' } },
    ],
    ['a plugin message', { type: 'plugin.hello', id: 'w1', payload: {} }],
    ['an unknown type', { type: 'shell.exec', id: 'w1', payload: {} }],
  ])('rejects %s', (_label, request) => {
    expect(checkWidgetRequest(request)).toEqual({
      ok: false,
      reply: errorReply('INVALID_REQUEST', 'unknown widget request', 'w1'),
    });
  });

  it('rejects requests without an id or a payload', () => {
    expect(checkWidgetRequest({ type: 'element.inspect', payload: {} })).toEqual({
      ok: false,
      reply: errorReply('INVALID_REQUEST', 'unknown widget request', undefined),
    });
    expect(checkWidgetRequest({ type: 'element.inspect', id: 'w2' })).toEqual({
      ok: false,
      reply: errorReply('INVALID_REQUEST', 'the request has no payload', 'w2'),
    });
    expect(checkWidgetRequest('element.inspect')).toEqual({
      ok: false,
      reply: errorReply('INVALID_REQUEST', 'requests must be objects', undefined),
    });
  });
});

describe('replyWindowMs', () => {
  it('waits longer for a generation than for edits', () => {
    expect(replyWindowMs('generate.request')).toBe(360_000);
    expect(replyWindowMs('dependencies.install')).toBe(270_000);
    expect(replyWindowMs('generate.cancel')).toBeUndefined();
    expect(replyWindowMs('finetune.preview')).toBeUndefined();
  });

  it('waits past the undo window for a Jira post', () => {
    expect(replyWindowMs('tracker.post')).toBe(90_000);
    expect(replyWindowMs('tracker.report')).toBe(90_000);
    expect(replyWindowMs('tracker.ticket')).toBe(60_000);
  });
});

describe('terminalLine for Jira', () => {
  const ref = { provider: 'jira', site: 'acme.atlassian.net', key: 'WEB-7' } as const;
  it('says whether a change was posted or held back', () => {
    expect(
      terminalLine({
        type: 'tracker.posted',
        payload: {
          ref,
          journalId: 'j1',
          outcome: 'posted',
          url: 'https://acme.atlassian.net/browse/WEB-7',
        },
      }),
    ).toBe('⇪ posted to WEB-7');
    expect(
      terminalLine({
        type: 'tracker.posted',
        payload: { ref, journalId: 'j1', outcome: 'cancelled', url: '' },
      }),
    ).toBe('⇪ nothing posted to WEB-7: the change was undone');
    expect(terminalLine({ type: 'tracker.reported', payload: { ref, url: '' } })).toBe(
      '⇪ created WEB-7',
    );
  });
});

describe('terminalLine', () => {
  it('announces finished generations with their route', () => {
    const summary =
      '"make it softer" → 3 variants for <button> src/A.tsx:3 (R1 · Claude Code haiku)';
    expect(
      terminalLine({
        type: 'generate.done',
        payload: {
          runId: 'r1',
          route: { tier: 'R1', provider: 'Claude Code', model: 'haiku' },
          summary,
          elapsedMs: 900,
          variants: [
            {
              changesetId: 'c1',
              label: 'Soft',
              system: 'Your project',
              style: 'Soft',
              rationale: 'r',
              file: 'src/A.tsx',
              created: [],
              changes: [],
            },
          ],
          dropped: [],
          update: { updateId: 'u1', status: 'ok', latencyMs: 20, errors: [] },
        },
      }),
    ).toBe(`✦ ${summary}`);
  });

  it('announces commits and undos, not other replies', () => {
    expect(
      terminalLine({
        type: 'commit.done',
        payload: {
          journalId: 'j1',
          files: ['src/A.tsx'],
          summary: 'src/A.tsx:3 · bg-brand → bg-sea',
        },
      }),
    ).toBe('✎ src/A.tsx:3 · bg-brand → bg-sea');
    expect(terminalLine({ type: 'undo.done', payload: { journalId: 'j2', undoOf: 'j1' } })).toBe(
      '↺ undid j1',
    );
    expect(terminalLine({ type: 'redo.done', payload: { journalId: 'j3', redoOf: 'j1' } })).toBe(
      '↻ redid j1',
    );
    expect(
      terminalLine({ type: 'journal.entries', payload: { entries: [], more: false } }),
    ).toBeUndefined();
    expect(
      terminalLine({ type: 'changeset.discarded', payload: { changesetId: 'c1' } }),
    ).toBeUndefined();
  });
});

describe('requestRunId', () => {
  it('names the run of the given request type only', () => {
    const discard = { type: 'generate.discard', id: 'w2', payload: { runId: 'r2' } };

    expect(requestRunId(discard, 'generate.discard')).toBe('r2');
    expect(requestRunId(discard, 'generate.cancel')).toBeUndefined();
  });
});

describe('generationRunId', () => {
  it('names the run of a generate.request and nothing else', () => {
    expect(generationRunId({ type: 'generate.request', id: 'w1', payload: { runId: 'r1' } })).toBe(
      'r1',
    );
    expect(generationRunId({ type: 'generate.cancel', payload: { runId: 'r1' } })).toBeUndefined();
    expect(generationRunId({ type: 'generate.request', payload: { runId: 7 } })).toBeUndefined();
    expect(generationRunId('generate.request')).toBeUndefined();
  });
});

describe('splitPage', () => {
  it('takes the page id off the request and falls back to the socket', () => {
    expect(splitPage({ type: 'x', id: 'w1', pageId: 'page-1' }, 'socket-1')).toEqual({
      pageId: 'page-1',
      reloaded: false,
      data: { type: 'x', id: 'w1' },
    });
    expect(splitPage({ type: 'x' }, 'socket-1')).toEqual({
      pageId: 'socket-1',
      reloaded: false,
      data: { type: 'x' },
    });
    expect(splitPage({ type: 'x', pageId: 'bad id!' }, 'socket-1')).toEqual({
      pageId: 'socket-1',
      reloaded: false,
      data: { type: 'x' },
    });
    expect(splitPage({ type: 'x', pageId: 7 }, 'socket-1').pageId).toBe('socket-1');
    expect(splitPage('text', 'socket-1')).toEqual({
      pageId: 'socket-1',
      reloaded: false,
      data: 'text',
    });
  });

  it('takes the load id off the request and drops one that is not an id', () => {
    expect(splitPage({ type: 'x', pageId: 'page-1', load: 'load-2' }, 'socket-1')).toEqual({
      pageId: 'page-1',
      reloaded: false,
      load: 'load-2',
      data: { type: 'x' },
    });
    expect(splitPage({ type: 'x', pageId: 'page-1', load: 'bad id!' }, 'socket-1').load).toBe(
      undefined,
    );
  });

  it('takes the reload flag off the request, and only a real true counts', () => {
    expect(splitPage({ type: 'x', pageId: 'page-1', reloaded: true }, 'socket-1')).toEqual({
      pageId: 'page-1',
      reloaded: true,
      data: { type: 'x' },
    });
    expect(splitPage({ type: 'x', pageId: 'page-1', reloaded: 'yes' }, 'socket-1')).toEqual({
      pageId: 'page-1',
      reloaded: false,
      data: { type: 'x' },
    });
    expect(requestId({ id: 'w3' })).toBe('w3');
    expect(requestId({ id: 3 })).toBeUndefined();
  });
});
