import { expect, type Locator, type Page, test } from '@playwright/test';
import { type FixtureServer, openFixture, startFixtureServer } from './support/fixture.js';

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture?.server.close();
});

function toolbar(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'GUIJam' });
}

function tooltip(page: Page, text: string): Locator {
  return toolbar(page).getByRole('tooltip').filter({ hasText: text });
}

test('each tool shows its name on hover and on keyboard focus', async ({ page }) => {
  await openFixture(page, fixture.url);
  const select = toolbar(page).getByRole('button', { name: 'Select object' });
  const draw = toolbar(page).getByRole('button', { name: 'Draw' });

  await expect(tooltip(page, 'Select object')).toBeHidden();
  await select.hover();
  await expect(tooltip(page, 'Select object')).toBeVisible();
  await expect(tooltip(page, 'Draw')).toBeHidden();
  await page.mouse.move(10, 10);
  await expect(tooltip(page, 'Select object')).toBeHidden();

  await draw.focus();
  await expect(tooltip(page, 'Draw')).toBeVisible();
  await expect(draw).toHaveAccessibleDescription('Draw');
  await expect(select.locator('svg')).toBeVisible();
});

test('the active tool turns into an Esc key that leaves it, as does the Escape key', async ({
  page,
}) => {
  await openFixture(page, fixture.url);
  const draw = toolbar(page).getByRole('button', { name: 'Draw' });

  await draw.click();

  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  await expect(draw).toHaveAttribute('aria-keyshortcuts', 'Escape');
  await expect(draw.getByText('Esc', { exact: true })).toBeVisible();
  await expect(draw.locator('svg')).toBeHidden();
  await expect(draw).toHaveAccessibleDescription('Press Esc to exit');

  await page.keyboard.press('Escape');

  await expect(draw).toHaveAttribute('aria-pressed', 'false');
  await expect(draw).not.toHaveAttribute('aria-keyshortcuts', /.*/);
  await expect(draw.locator('svg')).toBeVisible();
  await expect(draw).toHaveAccessibleDescription('Draw');

  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', 'false');
});

test('switching tools moves the Esc key to the new tool', async ({ page }) => {
  await openFixture(page, fixture.url);
  const select = toolbar(page).getByRole('button', { name: 'Select object' });
  const draw = toolbar(page).getByRole('button', { name: 'Draw' });

  await select.click();
  await expect(select.getByText('Esc', { exact: true })).toBeVisible();
  await draw.click();

  await expect(draw.getByText('Esc', { exact: true })).toBeVisible();
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await expect(select.getByText('Esc', { exact: true })).toBeHidden();
  await expect(select).toHaveAccessibleDescription('Select object');
});

test('hiding the toolbar with Alt+Shift+M also lets go of the Select tool', async ({ page }) => {
  await openFixture(page, fixture.url);
  const select = toolbar(page).getByRole('button', { name: 'Select object' });
  const counter = page.getByRole('button', { name: /Cups ordered/ });
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Alt+Shift+KeyM');

  await expect(toolbar(page)).toBeHidden();
  await counter.click();
  await expect(counter).toHaveText('Cups ordered: 1');

  await page.keyboard.press('Alt+Shift+KeyM');

  await expect(toolbar(page)).toBeVisible();
  await expect(select).toHaveAttribute('aria-pressed', 'false');
});
