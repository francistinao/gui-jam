import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface AstroDevServer {
  address: { port: number };
  stop: () => Promise<void>;
}

interface AstroModule {
  dev: (options: {
    root: string;
    logLevel: 'warn';
    server: { host: string; port: number };
  }) => Promise<AstroDevServer>;
}

export interface AstroServer {
  url: string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

export async function startAstro(dir: string): Promise<AstroServer> {
  process.env.ASTRO_TELEMETRY_DISABLED = '1';
  process.env.ASTRO_DISABLE_UPDATE_CHECK = 'true';
  const entry = createRequire(join(dir, 'package.json')).resolve('astro');
  const astro = (await import(pathToFileURL(entry).href)) as AstroModule;
  const port = await freePort();
  const server = await astro.dev({
    root: dir,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port },
  });
  return { url: `http://127.0.0.1:${server.address.port}/`, stop: () => server.stop() };
}
