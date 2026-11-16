import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import {
  GJD_BINARY,
  requireDaemonBinary,
  stopDaemon,
  waitForDaemon,
  widgetRequests,
} from './support/daemon.js';
import {
  FIXTURE_DIR,
  type FixtureServer,
  fileSnapshot,
  fixturePath,
  startFixtureServer,
} from './support/fixture.js';

const ORDER_BUTTON = fixturePath('src/components/OrderButton.tsx');
const BRAND_RGB = 'rgb(190, 18, 60)';
const BLUE_RGB = 'rgb(29, 78, 216)';

let fixture: FixtureServer;
let backend: Server;
let pageUrl: string;
let viteOrigin: string;

// What Laravel's `@viteReactRefresh` and `@vite('src/main.tsx')` print: the page comes from
// the backend, and every script from the Vite dev server.
function backendPage(vite: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Brew &amp; Co. (served by the backend)</title>
    <script type="module">
      import RefreshRuntime from '${vite}/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="${vite}/@vite/client"></script>
    <script type="module" src="${vite}/src/main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer('vite.backend.config.ts');
  viteOrigin = new URL(fixture.url).origin;
  const html = backendPage(viteOrigin);
  backend = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  pageUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}/`;
  await waitForDaemon(widgetRequests(fixture.api), {
    file: 'src/components/OrderButton.tsx',
    line: 3,
    column: 5,
  });
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await new Promise((resolve) => backend?.close(resolve));
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
});

test('a page rendered by another server gets the toolbar and loads the widget from Vite', async ({
  page,
}) => {
  const widgetRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/@guijam/widget.js',
  );
  await page.goto(pageUrl);

  const toolbar = page.getByRole('toolbar', { name: 'GUIJam' });
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveCount(1);
  const button = page.getByRole('button', { name: 'Order now' });
  await expect(button).toHaveAttribute('data-gj-src', 'src/components/OrderButton.tsx:3:5');

  await toolbar.getByRole('button', { name: 'Select' }).click();
  expect(new URL((await widgetRequest).url()).origin).toBe(viteOrigin);

  const before = await fileSnapshot(ORDER_BUTTON);
  await button.click();
  const panel = page.getByRole('dialog', { name: 'Fine-tune src/components/OrderButton.tsx' });
  await expect(panel.getByText('Reading the element…')).toHaveCount(0);
  await panel.getByRole('textbox', { name: 'Fill hex' }).fill('1d4ed8');
  await expect(button).toHaveCSS('background-color', BLUE_RGB);

  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('status')).toContainText('Unsaved tweaks were reverted.');
  await expect(button).toHaveCSS('background-color', BRAND_RGB);
  expect(await fileSnapshot(ORDER_BUTTON)).toEqual(before);
});
