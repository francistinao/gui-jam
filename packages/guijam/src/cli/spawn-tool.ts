import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

const PLAIN = /^[\w@+=:,./\\-]+$/;
const UNQUOTABLE = /["%\r\n]/;

export interface ToolInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

export function cmdArgument(arg: string): string {
  if (PLAIN.test(arg)) return arg;
  if (UNQUOTABLE.test(arg)) {
    throw new Error(`${JSON.stringify(arg)} can't be passed through cmd.exe safely`);
  }
  return `"${arg}"`;
}

export function toolInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ToolInvocation {
  if (platform !== 'win32') return { command, args: [...args], shell: false };
  return { command: [command, ...args].map(cmdArgument).join(' '), args: [], shell: true };
}

export function spawnTool(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const invocation = toolInvocation(command, args);
  return spawn(invocation.command, invocation.args, {
    ...options,
    shell: invocation.shell,
    windowsHide: true,
  });
}
