import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  GJD_BINARY,
  requireDaemonBinary,
  stopDaemon,
  waitForDaemon,
  widgetRequests,
} from './support/daemon.js';
import { FIXTURE_DIR, type FixtureServer, startFixtureServer } from './support/fixture.js';
import { searchPath } from './support/process.js';

const FAKE_CLI_DIR = fileURLToPath(new URL('../fake-cli/', import.meta.url));
const ORDER_BUTTON_REF = { file: 'src/components/OrderButton.tsx', line: 3, column: 5 };
const INFO = join(FIXTURE_DIR, '.guijam', 'run', 'daemon.json');

let fixture: FixtureServer;
let cliLog: string;
const savedEnv = { PATH: process.env.PATH };

interface Info {
  pid: number;
  version: string;
}

interface CliRun {
  pid?: number;
  request?: string;
}

async function info(): Promise<Info> {
  return JSON.parse(await readFile(INFO, 'utf8')) as Info;
}

async function cliRuns(): Promise<CliRun[]> {
  const text = await readFile(cliLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  cliLog = join(await mkdtemp(join(tmpdir(), 'guijam-fake-claude-')), 'runs.jsonl');
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  process.env.GUIJAM_FAKE_CLAUDE_LOG = cliLog;
  process.env.PATH = searchPath(FAKE_CLI_DIR, savedEnv.PATH);
  fixture = await startFixtureServer();
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  delete process.env.GUIJAM_FAKE_CLAUDE_LOG;
  process.env.PATH = savedEnv.PATH;
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('a daemon from another GUIJam version is replaced when the dev server connects', async () => {
  const before = await info();
  await fixture.server.close();
  await writeFile(INFO, JSON.stringify({ ...before, version: '0.0.0-older' }));

  fixture = await startFixtureServer();
  await waitForDaemon(widgetRequests(fixture.api), ORDER_BUTTON_REF);

  const after = await info();
  expect(after.pid).not.toBe(before.pid);
  expect(after.version).toBe(before.version);
  await expect.poll(() => alive(before.pid)).toBe(false);
});

test('stopping the daemon stops the AI tool runs it started', async () => {
  const send = widgetRequests(fixture.api);
  const reply = send('generate.request', {
    runId: 'e2e-orphan',
    ...ORDER_BUTTON_REF,
    prompt: 'Make it blue with a soft shadow, slowly and then stopped',
  }).catch(() => undefined);
  const started = async () =>
    (await cliRuns())
      .filter((run) => run.request?.includes('slowly and then stopped'))
      .flatMap((run) => (run.pid === undefined ? [] : [run.pid]));
  await expect.poll(async () => (await started()).length).toBe(3);
  const pids = await started();
  expect(pids.every(alive)).toBe(true);

  await stopDaemon(FIXTURE_DIR);

  await expect.poll(() => pids.filter(alive), { timeout: 5_000 }).toEqual([]);
  await reply;
});
