import { describe, expect, it } from 'vitest';
import { cmdArgument, toolInvocation } from './spawn-tool.js';

describe('toolInvocation', () => {
  it('runs tools directly outside Windows', () => {
    expect(toolInvocation('npm', ['install', '--save-dev', 'guijam@0.1.0'], 'darwin')).toEqual({
      command: 'npm',
      args: ['install', '--save-dev', 'guijam@0.1.0'],
      shell: false,
    });
  });

  it('runs tools through cmd.exe on Windows so npm.cmd and pnpm.cmd are found', () => {
    expect(toolInvocation('npm', ['install', '--save-dev', 'guijam@0.1.0'], 'win32')).toEqual({
      command: 'npm install --save-dev guijam@0.1.0',
      args: [],
      shell: true,
    });
    expect(toolInvocation('pnpm', ['add', '-D', '@guijam/x', 'a b'], 'win32').command).toBe(
      'pnpm add -D @guijam/x "a b"',
    );
  });
});

describe('cmdArgument', () => {
  it('quotes what cmd.exe would split and refuses what it would expand', () => {
    expect(cmdArgument('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(cmdArgument('a&b')).toBe('"a&b"');
    expect(cmdArgument('')).toBe('""');
    for (const unsafe of ['%PATH%', 'say "hi"', 'two\nlines']) {
      expect(() => cmdArgument(unsafe)).toThrow("can't be passed through cmd.exe safely");
    }
  });
});
