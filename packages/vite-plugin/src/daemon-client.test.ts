import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuijamMessage } from '@guijam/contracts-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket as Peer, WebSocketServer } from 'ws';
import { DaemonClient, DaemonUnavailableError } from './daemon-client.js';

const OURS = '9.9.9';
const THEIRS = '0.1.0-old';
const CONFLICT = `Another dev server runs GUIJam ${THEIRS} for this project.`;
const ACTION = 'Stop it, then restart this dev server.';

const FAKE_GJD = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const [command, sub, , project] = process.argv.slice(2);
if (command === '--version') {
  process.stdout.write('gjd ' + process.env.FAKE_GJD_VERSION + '\\n');
  process.exit(0);
}
appendFileSync(process.env.FAKE_GJD_CALLS, sub + '\\n');
const info = join(project, '.guijam', 'run', 'daemon.json');
if (sub === 'stop') rmSync(info, { force: true });
if (sub === 'run' && process.env.FAKE_GJD_STARTS) {
  mkdirSync(dirname(info), { recursive: true });
  writeFileSync(info, process.env.FAKE_GJD_STARTS);
}
`;

interface FakeDaemon {
  port: number;
  peers: Peer[];
  close(): Promise<void>;
}

async function fakeDaemon(): Promise<FakeDaemon> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const peers: Peer[] = [];
  server.on('connection', (peer) => peers.push(peer));
  return {
    port: (server.address() as AddressInfo).port,
    peers,
    close: () =>
      new Promise((resolve) => {
        for (const peer of peers) peer.terminate();
        server.close(() => resolve());
      }),
  };
}

function info(pid: number, daemon: FakeDaemon, version: string): string {
  return JSON.stringify({ pid, port: daemon.port, token: 't', protocol: 1, version });
}

describe.skipIf(process.platform === 'win32')('DaemonClient and daemons of another version', () => {
  let dir: string;
  let root: string;
  let infoPath: string;
  let calls: string;
  let client: DaemonClient | undefined;
  let reasons: string[];
  const daemons: FakeDaemon[] = [];
  const saved = { ...process.env };

  const started = async () => {
    const daemon = await fakeDaemon();
    daemons.push(daemon);
    return daemon;
  };
  const called = () => readFile(calls, 'utf8').catch(() => '');
  const connect = () => {
    client = new DaemonClient({
      root,
      binary: join(dir, 'gjd'),
      hello: () => ({ type: 'plugin.hello', payload: {} }) as unknown as GuijamMessage,
      onMessage: async () => undefined,
      onConnectionChange: () => undefined,
      onUnavailable: (reason) => reasons.push(reason),
    });
    client.start();
    return client;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guijam-daemon-client-'));
    root = join(dir, 'project');
    infoPath = join(root, '.guijam', 'run', 'daemon.json');
    calls = join(dir, 'calls');
    reasons = [];
    await mkdir(join(root, '.guijam', 'run'), { recursive: true });
    await writeFile(join(dir, 'gjd'), FAKE_GJD, { mode: 0o755 });
    process.env.FAKE_GJD_VERSION = OURS;
    process.env.FAKE_GJD_CALLS = calls;
    delete process.env.FAKE_GJD_STARTS;
  });

  afterEach(async () => {
    client?.stop();
    client = undefined;
    for (const daemon of daemons.splice(0)) await daemon.close();
    process.env = { ...saved };
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces a leftover daemon of another version when the dev server starts', async () => {
    const leftover = await started();
    const fresh = await started();
    await writeFile(infoPath, info(process.ppid, leftover, THEIRS));
    process.env.FAKE_GJD_STARTS = info(process.pid, fresh, OURS);

    connect();

    await vi.waitFor(() => expect(fresh.peers).toHaveLength(1));
    expect(leftover.peers).toHaveLength(0);
    expect(await called()).toBe('stop\nrun\n');
    expect(reasons).toEqual([]);
  });

  it('joins no daemon of another version that another dev server starts meanwhile', async () => {
    const theirs = await started();
    process.env.FAKE_GJD_STARTS = info(process.pid, theirs, THEIRS);

    const connecting = connect();

    await vi.waitFor(() => expect(reasons).toEqual([`${CONFLICT} ${ACTION}`]));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(theirs.peers).toHaveLength(0);
    expect(await called()).toBe('run\n');
    const refused = await connecting
      .request({ type: 'element.inspect', payload: {} })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DaemonUnavailableError);
    expect(refused).toMatchObject({ message: CONFLICT, action: ACTION });
  });

  it('leaves a daemon of another version alone once it has been connected, and reports it', async () => {
    const ours = await started();
    const theirs = await started();
    await writeFile(infoPath, info(process.pid, ours, OURS));

    const connecting = connect();

    await vi.waitFor(() => expect(ours.peers).toHaveLength(1));
    expect(await called()).toBe('');

    await writeFile(infoPath, info(process.ppid, theirs, THEIRS));
    ours.peers[0]?.terminate();

    await vi.waitFor(() => expect(reasons).toEqual([`${CONFLICT} ${ACTION}`]));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(theirs.peers).toHaveLength(0);
    expect(await called()).toBe('');
    await expect(
      connecting.request({ type: 'element.inspect', payload: {} }),
    ).rejects.toMatchObject({ message: CONFLICT, action: ACTION });
  });
});
