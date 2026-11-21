import { describe, expect, it } from 'vitest';
import { uiTicketsJql } from '../src/tools';

describe('MCP tools', () => {
  it('lists one GUIJam status or all of them, never raw input', () => {
    expect(uiTicketsJql('applied')).toBe('guijamStatus = "applied" ORDER BY updated DESC');
    expect(uiTicketsJql(undefined)).toBe(
      'guijamStatus in ("queued", "in_progress", "applied", "reverted") ORDER BY updated DESC',
    );
    expect(uiTicketsJql('" OR project = SECRET')).toBe(uiTicketsJql(undefined));
  });
});
