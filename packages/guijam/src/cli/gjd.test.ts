import { describe, expect, it } from 'vitest';
import { defaultProvider, parseProviderList, providerHint } from './gjd.js';

const LIST = JSON.stringify([
  {
    id: 'claude-code',
    name: 'Claude Code',
    active: false,
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    installed: true,
    auth: 'not_logged_in',
    version: '2.1.325',
    loginCommand: 'claude auth login',
  },
  {
    id: 'codex',
    name: 'Codex',
    active: false,
    installCommand: 'npm install -g @openai/codex',
    installed: true,
    auth: 'logged_in',
    version: '0.169.0',
  },
]);

describe('parseProviderList', () => {
  it('reads what gjd provider list --json prints', () => {
    const [claude, codex] = parseProviderList(LIST);

    expect(claude).toMatchObject({
      id: 'claude-code',
      loginCommand: 'claude auth login',
      reason: undefined,
    });
    expect(codex).toMatchObject({ id: 'codex', auth: 'logged_in', loginCommand: undefined });
  });

  it('rejects entries it does not understand', () => {
    expect(() => parseProviderList('[{"id":"x"}]')).toThrow(/unexpected provider entry/);
    expect(() => parseProviderList('{}')).toThrow(/provider list/);
  });
});

describe('defaultProvider', () => {
  it('prefers the saved choice, then the first logged-in CLI', () => {
    const providers = parseProviderList(LIST);

    expect(defaultProvider(providers)?.id).toBe('codex');
    expect(
      defaultProvider(providers.map((entry) => ({ ...entry, active: entry.id === 'claude-code' })))
        ?.id,
    ).toBe('claude-code');
  });
});

describe('providerHint', () => {
  it('summarises install and login state', () => {
    const [claude, codex] = parseProviderList(LIST);
    if (claude === undefined || codex === undefined) throw new Error('fixture');

    expect(providerHint(claude)).toBe('not logged in · 2.1.325');
    expect(providerHint(codex)).toBe('logged in · 0.169.0');
    expect(providerHint({ ...codex, installed: false })).toBe('not installed');
  });
});
