import { describe, expect, it } from 'vitest';
import { checkWidgetRequest, errorReply, terminalLine } from './relay.js';

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

describe('terminalLine', () => {
  it('announces commits and undos only', () => {
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
