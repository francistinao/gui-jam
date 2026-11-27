import { readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { png } from './images.js';

export const FIGMA_TOKEN = 'figd_qa_references';

export interface References {
  origin: string;
  page: string;
  frame: string;
  seen: { path: string; headers: IncomingHttpHeaders }[];
  stop(): Promise<void>;
}

export interface CliRun {
  request?: string;
  links?: { url: string; code?: { lang: string | null; code: string }[] }[];
  figma?: { node: string }[];
}

function nodesFor(ids: string): string {
  return JSON.stringify({
    name: 'Shop',
    nodes: Object.fromEntries(
      ids.split(',').map((id) => [
        id,
        {
          document: {
            type: 'FRAME',
            name: `Frame ${id}`,
            absoluteBoundingBox: { width: 320, height: 200 },
            children: [],
          },
          components: {},
          styles: {},
        },
      ]),
    ),
  });
}

export function frameLink(node: string, file = 'KEY'): string {
  return `https://www.figma.com/design/${file}/Shop?node-id=${node.replace(':', '-')}`;
}

export async function startReferences(): Promise<References> {
  const seen: References['seen'] = [];
  let origin = '';
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://site');
    seen.push({ path: url.pathname, headers: request.headers });
    const json = (status: number, body: string) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(body);
    if (url.pathname === '/figma-api/v1/files/DENIED/nodes') {
      json(403, '{"status":403,"err":"Invalid token"}');
    } else if (url.pathname === '/figma-api/v1/files/KEY/nodes') {
      json(200, nodesFor(url.searchParams.get('ids') ?? ''));
    } else if (url.pathname === '/figma-api/v1/images/KEY') {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      json(
        200,
        JSON.stringify({
          images: Object.fromEntries(ids.map((id) => [id, `${origin}/render.png`])),
        }),
      );
    } else if (url.pathname === '/render.png') {
      response.writeHead(200, { 'content-type': 'image/png' }).end(png(64, 40));
    } else if (url.pathname === '/page') {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>Page ${url.searchParams.get('n')}</title><h1>Plans</h1><p>${'Coffee plans for every week. '.repeat(12)}</p>`,
        );
    } else {
      response.writeHead(404).end('not here');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.GUIJAM_FIGMA_API = `${origin}/figma-api`;
  process.env.GUIJAM_FIGMA_TOKEN = FIGMA_TOKEN;
  return {
    origin,
    page: `${origin}/page?n=1`,
    frame: frameLink('12:34'),
    seen,
    stop: async () => {
      delete process.env.GUIJAM_FIGMA_API;
      delete process.env.GUIJAM_FIGMA_TOKEN;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function cliRuns(log: string): Promise<CliRun[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
}
