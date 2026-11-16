import { expect, test } from '@playwright/test';
import type * as Vite from 'vite';
import { type FixtureServer, openFixture, startFixtureServer } from './support/fixture.js';

let fixture: FixtureServer;
let server: Vite.ViteDevServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
  server = fixture.server;
});

test.afterAll(async () => {
  await server?.close();
});

test('maps rendered elements to their JSX source location', async ({ page }) => {
  await openFixture(page, fixture.url);

  await expect(page.getByRole('button', { name: 'Order now' })).toHaveAttribute(
    'data-gj-src',
    'src/components/OrderButton.tsx:3:5',
  );
  await expect(page.getByText('Ube Latte')).toHaveAttribute('data-gj-src', 'src/App.tsx:34:20');
  await expect(page.locator('article[data-gj-src="src/components/MenuCard.tsx:11:5"]')).toHaveCount(
    3,
  );
});
