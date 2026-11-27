import { describe, expect, it } from 'vitest';
import {
  defaultProvider,
  parseFigmaStatus,
  parseJiraStatus,
  parseModelList,
  parseProviderList,
  probeSummary,
  providerHint,
  rankModels,
  usableModels,
} from './gjd.js';

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

describe('models', () => {
  it('reads the model list and puts DeepSeek and GLM first, free models last', () => {
    const models = parseModelList(
      JSON.stringify([
        { id: 'opencode/glm-5.3-flash-free', name: 'GLM Free', images: false, free: true },
        { id: 'openai/gpt-5', name: 'GPT-5', images: true, free: false },
        { id: 'zai/glm-4.6v', name: 'GLM-4.6V', images: true, free: false },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', images: false, free: false },
      ]),
    );

    expect(rankModels(models).map((model) => model.id)).toEqual([
      'deepseek/deepseek-chat',
      'zai/glm-4.6v',
      'openai/gpt-5',
      'opencode/glm-5.3-flash-free',
    ]);
    expect(() => parseModelList('[{"id":1}]')).toThrow(/unexpected model entry/);
  });
});

describe('probeSummary', () => {
  it('reports how long a successful test request took', () => {
    expect(
      probeSummary(
        'opencode 1.19.5 · logged in\nmodel opencode/glm-5.3-flash-free\nrun 1: ready 812 ms · answer 6345 ms\n',
        '',
      ),
    ).toEqual({ ok: true, summary: 'answered in 6.3 s' });
  });

  it("repeats the AI tool's own reason when the request fails", () => {
    expect(
      probeSummary(
        'opencode 1.19.5 · logged in\n',
        'run 1: opencode refused the request (Invalid API key); run `opencode auth login` in a terminal, then retry\n',
      ),
    ).toEqual({
      ok: false,
      summary:
        'opencode refused the request (Invalid API key); run `opencode auth login` in a terminal, then retry',
    });
    expect(probeSummary('', 'gemini-cli: Gemini CLI is not installed\n')).toEqual({
      ok: false,
      summary: 'Gemini CLI is not installed',
    });
  });
});

describe('usableModels', () => {
  it("drops OpenCode's free models, which refuse other tools, and keeps free models of your own providers", () => {
    const model = (id: string, free: boolean) => ({ id, name: id, images: false, free });
    expect(
      usableModels([
        model('opencode/big-pickle', true),
        model('opencode/claude-fable-5', false),
        model('lmstudio/qwen3-coder', true),
        model('deepseek/deepseek-chat', false),
      ]).map((entry) => entry.id),
    ).toEqual(['opencode/claude-fable-5', 'lmstudio/qwen3-coder', 'deepseek/deepseek-chat']);
  });
});

describe('parseJiraStatus', () => {
  it('reads each paired site and why one is unreachable', () => {
    expect(
      parseJiraStatus(
        JSON.stringify([
          { site: 'acme.atlassian.net', account: 'Francis', ok: true },
          {
            site: 'beta.atlassian.net',
            account: 'Francis',
            ok: false,
            error: 'Jira no longer accepts this pairing.',
          },
        ]),
      ),
    ).toEqual([
      { site: 'acme.atlassian.net', account: 'Francis', ok: true, error: undefined },
      {
        site: 'beta.atlassian.net',
        account: 'Francis',
        ok: false,
        error: 'Jira no longer accepts this pairing.',
      },
    ]);
    expect(parseJiraStatus('{}')).toEqual([]);
  });
});

describe('parseFigmaStatus', () => {
  it('reads where the token is and whether Figma accepted it', () => {
    expect(parseFigmaStatus('{"token":"keychain","accepted":true,"error":null}')).toEqual({
      token: 'keychain',
      accepted: true,
      error: null,
    });
    expect(parseFigmaStatus('{"token":null,"accepted":null,"error":null}')).toEqual({
      token: null,
      accepted: null,
      error: null,
    });
    expect(() => parseFigmaStatus('[]')).toThrow();
  });
});
