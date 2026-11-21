import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';
export const SITE = 'acme.atlassian.net';
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
}

export interface Bridge {
  server: Server;
  url: string;
  calls: Call[];
  slowTicketMs: number;
}

const trackers = () => join(process.env.XDG_CONFIG_HOME ?? '', 'guijam', 'trackers.toml');

function answer(call: Call): { status: number; body: unknown } {
  const data = (value: unknown) => ({ status: 200, body: { ok: true, data: value } });
  const { method, path } = call;
  if (method === 'GET' && path === '/v1/whoami') {
    return data({
      accountId: 'acct-1',
      displayName: 'Francis',
      site: SITE,
      url: `https://${SITE}`,
      projects: [{ key: 'WEB', name: 'Web' }],
    });
  }
  if (method === 'GET' && path === '/v1/tickets') {
    return data({
      tickets: [
        { key: 'WEB-1', summary: 'Rename the hero heading', status: 'To Do', type: 'Task' },
        { key: 'WEB-2', summary: 'Make Order now a pill', status: 'To Do', type: 'Task' },
      ],
    });
  }
  if (method === 'GET' && path === '/v1/tickets/WEB-1') {
    return data({
      key: 'WEB-1',
      summary: 'Rename the hero heading',
      description: 'It should say "Fresh coffee, every morning".',
      status: 'To Do',
      attachments: [{ id: '7', filename: 'mock.png', mimeType: 'image/png', size: 70 }],
      transitions: [{ id: '31', name: 'In Review' }],
    });
  }
  if (method === 'GET' && path === '/v1/tickets/WEB-1/attachments/7') {
    return data({ mediaType: 'image/png', base64: PIXEL });
  }
  if (method === 'POST' && /^\/v1\/tickets\/WEB-1\/(start|reverted)$/.test(path)) return data({});
  if (method === 'POST' && path === '/v1/tickets/WEB-1/result') {
    return data({ key: 'WEB-1', url: `https://${SITE}/browse/WEB-1` });
  }
  if (method === 'POST' && path === '/v1/tickets') {
    return data({ key: 'WEB-99', url: `https://${SITE}/browse/WEB-99` });
  }
  return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: `no ${method} ${path}` } };
}

export function startBridge(): Promise<Bridge> {
  const calls: Call[] = [];
  let started: Bridge | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/public\/trigger/, '');
      const text = Buffer.concat(chunks).toString();
      const call: Call = {
        method: request.method ?? 'GET',
        path,
        query: Object.fromEntries(url.searchParams),
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
      const allowed = request.headers.authorization === `Bearer ${TOKEN}`;
      if (allowed) calls.push(call);
      const reply = allowed
        ? answer(call)
        : { status: 401, body: { ok: false, code: 'UNAUTHORIZED', message: 'bad token' } };
      const delay = call.path === '/v1/tickets/WEB-1' ? (started?.slowTicketMs ?? 0) : 0;
      setTimeout(() => {
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply.body));
      }, delay);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      started = { server, url: `http://127.0.0.1:${port}/public/trigger`, calls, slowTicketMs: 0 };
      resolve(started);
    });
  });
}

export function callsOf(bridge: Bridge, path: string, method = 'POST'): Call[] {
  return bridge.calls.filter((call) => call.path === path && call.method === method);
}

export async function pairWith(bridge: Bridge): Promise<void> {
  await mkdir(join(process.env.XDG_CONFIG_HOME ?? '', 'guijam'), { recursive: true });
  await writeFile(
    trackers(),
    `[jira."${SITE}"]\nurl = "${bridge.url}"\ntoken = "${TOKEN}"\naccount = "Francis"\n`,
    { mode: 0o600 },
  );
}

export async function unpair(): Promise<void> {
  await rm(trackers(), { force: true });
}
