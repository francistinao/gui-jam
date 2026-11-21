import { readFile, writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page, test } from '@playwright/test';
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
  fixturePath,
  openFixture,
  startFixtureServer,
} from './support/fixture.js';
import {
  type Bridge,
  type Call,
  callsOf,
  pairWith,
  SITE,
  startBridge,
  unpair,
} from './support/jira-bridge.js';

const APP_FILE = 'src/App.tsx';
const APP = fixturePath(APP_FILE);
const POST_MS = 25_000;

let fixture: FixtureServer;
let bridge: Bridge;
let original: string;

function calls(path: string, method = 'POST'): Call[] {
  return callsOf(bridge, path, method);
}

function selectTool(page: Page): Locator {
  return page
    .getByRole('toolbar', { name: 'GUIJam' })
    .getByRole('button', { name: 'Select object' });
}

function finetune(page: Page): Locator {
  return page.getByRole('dialog', { name: `Fine-tune ${APP_FILE}` });
}

function heading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

async function selectHeading(page: Page): Promise<Locator> {
  await openFixture(page, fixture.url);
  await selectTool(page).click();
  await heading(page).click();
  return finetune(page);
}

async function linkWeb1(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Link a Jira ticket' }).click();
  const list = panel.getByRole('list', { name: 'Tickets' });
  await expect(list.getByRole('button')).toHaveText([
    'WEB-1 · Rename the hero heading',
    'WEB-2 · Make Order now a pill',
  ]);
  await list.getByRole('button', { name: 'WEB-1 · Rename the hero heading' }).click();
  await expect(panel.getByRole('region', { name: 'Linked ticket' })).toContainText(
    'WEB-1 · Rename the hero heading',
  );
}

async function editHeading(panel: Locator, value: string): Promise<void> {
  await panel.getByRole('textbox', { name: 'Text content', exact: true }).fill(value);
  await expect(panel.getByText('Unsaved')).toBeVisible();
}

test.beforeAll(async () => {
  await requireDaemonBinary();
  await stopDaemon(FIXTURE_DIR);
  bridge = await startBridge();
  await pairWith(bridge);
  process.env.GUIJAM_GJD_BIN = GJD_BINARY;
  fixture = await startFixtureServer();
  original = await readFile(APP, 'utf8');
  await waitForDaemon(widgetRequests(fixture.api), { file: APP_FILE, line: 31, column: 11 });
});

test.beforeEach(() => {
  bridge.calls.length = 0;
  bridge.slowTicketMs = 0;
});

test.afterEach(async () => {
  if ((await readFile(APP, 'utf8')) !== original) await writeFile(APP, original);
});

test.afterAll(async () => {
  delete process.env.GUIJAM_GJD_BIN;
  await unpair();
  await fixture?.server.close();
  await stopDaemon(FIXTURE_DIR);
  bridge?.server.close();
});

test('a linked ticket gets the change, the diff and before/after once Undo is gone', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const panel = await selectHeading(page);
  await linkWeb1(panel);
  await expect.poll(() => calls('/v1/tickets/WEB-1/start')).toHaveLength(1);
  expect(calls('/v1/tickets/WEB-1/start')[0]?.body).toEqual({
    pageUrl: `${fixture.url}`,
    src: `${APP_FILE}:31:11`,
  });
  await panel.getByRole('combobox', { name: 'Move the ticket to' }).selectOption('In Review');

  await editHeading(panel, 'Fresh coffee, every morning');
  await panel.getByRole('button', { name: 'Apply' }).click();

  const applied = page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' });
  await expect(applied).toContainText('Posts to WEB-1 in 10 s unless you undo.');
  expect(calls('/v1/tickets/WEB-1/result')).toHaveLength(0);

  await expect.poll(() => calls('/v1/tickets/WEB-1/result'), { timeout: POST_MS }).toHaveLength(1);
  const posted = calls('/v1/tickets/WEB-1/result')[0]?.body ?? {};
  expect(posted).toMatchObject({
    src: `${APP_FILE}:31:11`,
    files: [APP_FILE],
    agent: 'Direct edit, no AI',
    transitionId: '31',
  });
  expect(JSON.stringify(posted.changes)).toContain('Fresh coffee, every morning');
  expect(String(posted.patch)).toContain('+++ b/src/App.tsx');
  expect((posted.before as unknown[]).length).toBeGreaterThan(0);
  expect((posted.after as unknown[]).length).toBeGreaterThan(0);
  const done = page.getByRole('status').filter({ hasText: 'Posted to WEB-1.' });
  await expect(done.getByRole('link', { name: 'Open WEB-1' })).toHaveAttribute(
    'href',
    `https://${SITE}/browse/WEB-1`,
  );

  const journalId = String(posted.journalId);
  const undo = await widgetRequests(fixture.api)('journal.undo', { journalId });
  expect(undo.type).toBe('undo.done');
  await expect.poll(() => calls('/v1/tickets/WEB-1/reverted')).toHaveLength(1);
  expect(calls('/v1/tickets/WEB-1/reverted')[0]?.body).toEqual({ journalId });
  await expect.poll(() => readFile(APP, 'utf8')).toBe(original);
});

test('Undo inside the window posts nothing', async ({ page }) => {
  test.setTimeout(60_000);
  const panel = await selectHeading(page);
  await linkWeb1(panel);
  await editHeading(panel, 'Not this one');
  await panel.getByRole('button', { name: 'Apply' }).click();
  const applied = page.getByRole('status').filter({ hasText: 'Applied to App.tsx.' });
  await applied.getByRole('button', { name: 'Undo' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Change undone. Nothing was posted to WEB-1.' }),
  ).toBeVisible({ timeout: POST_MS });
  expect(calls('/v1/tickets/WEB-1/result')).toHaveLength(0);
  await expect.poll(() => readFile(APP, 'utf8')).toBe(original);
});

test('Ask AI fills the prompt and images from the linked ticket', async ({ page }) => {
  const panel = await selectHeading(page);
  await panel.getByRole('button', { name: 'Ask AI' }).click();
  const prompt = page.getByRole('dialog', { name: `Ask AI ${APP_FILE}` });
  await prompt.getByRole('button', { name: 'Link a Jira ticket' }).click();
  await prompt.getByRole('textbox', { name: 'Ticket key or search' }).fill('web-1');
  await expect.poll(() => bridge.calls.at(-1)?.query).toEqual({ preset: 'assigned', q: 'web-1' });
  bridge.slowTicketMs = 1500;
  await prompt.getByRole('button', { name: 'WEB-1 · Rename the hero heading' }).click();

  await expect(prompt.getByRole('status')).toHaveText('Reading WEB-1 from Jira…');
  await expect(prompt.getByText('Filling in from WEB-1…')).toBeVisible();
  await expect(prompt.getByRole('textbox', { name: 'Describe the change' })).toBeDisabled();
  await expect(prompt.getByRole('button', { name: 'Link a Jira ticket' })).toHaveCount(0);

  await expect(prompt.getByRole('textbox', { name: 'Describe the change' })).toHaveValue(
    '[WEB-1] Rename the hero heading\n\nIt should say "Fresh coffee, every morning".',
  );
  await expect(prompt.getByRole('img', { name: 'mock.png' })).toBeVisible();
  await prompt.getByRole('button', { name: 'Unlink WEB-1' }).click();
  await expect(prompt.getByRole('button', { name: 'Link a Jira ticket' })).toBeVisible();
});

test('Report to Jira files a ticket with the screenshot, file and page', async ({ page }) => {
  const panel = await selectHeading(page);
  await panel.getByRole('button', { name: 'Report to Jira' }).click();
  const form = panel.getByRole('form', { name: 'Report to Jira' });
  await form.getByRole('textbox', { name: 'Ticket summary' }).fill('Heading wraps on mobile');
  await form.getByRole('textbox', { name: 'Ticket description' }).fill('Seen on a phone.');
  await form.getByRole('button', { name: 'Create ticket' }).click();

  const created = page.getByRole('status').filter({ hasText: 'Created WEB-99.' });
  await expect(created.getByRole('link', { name: 'Open WEB-99' })).toBeVisible();
  const [report] = calls('/v1/tickets');
  expect(report?.body).toMatchObject({
    project: 'WEB',
    summary: 'Heading wraps on mobile',
    description: 'Seen on a phone.',
    src: `${APP_FILE}:31:11`,
    pageUrl: fixture.url,
  });
  expect(report?.body.image).toMatchObject({ mediaType: 'image/jpeg' });
});

test('a ?guijam-ticket= link from Jira links the ticket to the next selection', async ({
  page,
}) => {
  await openFixture(page, `${fixture.url}?guijam-ticket=WEB-1`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Select the element for WEB-1.' }),
  ).toBeVisible();
  await expect(selectTool(page)).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).search).toBe('');
  await heading(page).click();
  await expect(finetune(page).getByRole('region', { name: 'Linked ticket' })).toContainText(
    'WEB-1 · Rename the hero heading',
  );
});
