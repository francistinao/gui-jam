import { describe, expect, it } from 'vitest';
import {
  checkWidgetRequest,
  errorReply,
  generationRunId,
  replyWindowMs,
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
    expect(replyWindowMs('generate.request')).toBe(90_000);
    expect(replyWindowMs('generate.cancel')).toBeUndefined();
    expect(replyWindowMs('finetune.preview')).toBeUndefined();
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
          summary: 'src/A.tsx:3 — bg-brand → bg-sea',
        },
      }),
    ).toBe('✎ src/A.tsx:3 — bg-brand → bg-sea');
    expect(terminalLine({ type: 'undo.done', payload: { journalId: 'j2', undoOf: 'j1' } })).toBe(
      '↺ undid j1',
    );
    expect(
      terminalLine({ type: 'changeset.discarded', payload: { changesetId: 'c1' } }),
    ).toBeUndefined();
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
