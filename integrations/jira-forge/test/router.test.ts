import { describe, expect, it } from 'vitest';
import { findPairing } from '../src/pairing';
import { handle, MAX_BODY, routeOf, ticketJql } from '../src/router';
import { ACCOUNT, issue, NOW, OPS, PNG, parsed, request, setup, WEB } from './fakes';

const result = (journalId = 'j1', extra: Record<string, unknown> = {}) => ({
  journalId,
  summary: 'src/App.tsx:12 · bg-brand',
  files: ['src/App.tsx'],
  changes: [
    { file: 'src/App.tsx', line: 12, before: ['<b className="a">'], after: ['<b className="b">'] },
  ],
  patch: '--- a/src/App.tsx\n+++ b/src/App.tsx\n',
  pageUrl: 'http://localhost:5173/',
  src: 'src/App.tsx:12:7',
  agent: 'Direct edit, no AI',
  before: [{ mediaType: 'image/jpeg', base64: PNG }],
  after: [{ mediaType: 'image/jpeg', base64: PNG }],
  ...extra,
});

describe('authentication', () => {
  it('refuses requests without a valid pairing token', async () => {
    const { deps } = await setup();
    for (const token of [null, 'nope', 'tok_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
      const answer = parsed(await handle(request('GET', '/v1/whoami', { token }), deps));
      expect(answer).toMatchObject({ status: 401, ok: false, code: 'UNAUTHORIZED' });
    }
  });

  it('answers whoami with the site and the projects this person may use', async () => {
    const { deps } = await setup();
    const answer = parsed(await handle(request('GET', '/v1/whoami'), deps));
    expect(answer).toEqual({
      status: 200,
      ok: true,
      data: {
        accountId: ACCOUNT,
        displayName: 'Francis',
        site: 'acme.atlassian.net',
        url: 'https://acme.atlassian.net',
        projects: [
          { key: 'WEB', name: 'Web' },
          { key: 'OPS', name: 'Ops' },
        ],
      },
    });
  });

  it('rate-limits a token and rejects bodies over 5 MB', async () => {
    const { deps, advance } = await setup();
    for (let index = 0; index < 120; index += 1) {
      expect((await handle(request('GET', '/v1/whoami'), deps)).statusCode).toBe(200);
    }
    expect(parsed(await handle(request('GET', '/v1/whoami'), deps))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    advance(60_000);
    expect((await handle(request('GET', '/v1/whoami'), deps)).statusCode).toBe(200);
    const huge = request('POST', '/v1/tickets', { body: 'x'.repeat(MAX_BODY + 1) });
    expect(parsed(await handle(huge, deps))).toMatchObject({ status: 413, code: 'TOO_LARGE' });
  });

  it('unpairs the calling device so its token stops working', async () => {
    const { deps, store } = await setup();
    expect((await handle(request('POST', '/v1/unpair', { body: {} }), deps)).statusCode).toBe(200);
    expect(await findPairing(store, 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab')).toBeUndefined();
    expect((await handle(request('GET', '/v1/whoami'), deps)).statusCode).toBe(401);
  });
});

describe('reading tickets', () => {
  it('searches only paired projects and keeps what the person may browse', async () => {
    const { deps, jira } = await setup();
    jira.add(issue('WEB-1', WEB.id)).add(issue('WEB-2', WEB.id)).add(issue('SEC-3', '30'));
    jira.grants = { BROWSE_PROJECTS: ['1001'] };
    const answer = parsed(
      await handle(request('GET', '/v1/tickets', { query: { preset: 'assigned', q: '' } }), deps),
    );
    expect(answer.data).toEqual({
      tickets: [{ key: 'WEB-1', summary: 'Summary of WEB-1', status: 'To Do', type: 'Task' }],
    });
    expect(jira.searches[0]).toBe(
      `project in (10, 20) AND assignee = "${ACCOUNT}" AND statusCategory != Done ORDER BY updated DESC`,
    );
  });

  it('falls back to the projects recorded at pairing when Jira refuses the check', async () => {
    const { deps, jira } = await setup();
    jira.add(issue('WEB-1', WEB.id)).add(issue('SEC-3', '30'));
    jira.grants = 'unavailable';
    const answer = parsed(await handle(request('GET', '/v1/tickets'), deps));
    expect((answer.data as { tickets: { key: string }[] }).tickets.map((t) => t.key)).toEqual([
      'WEB-1',
    ]);
  });

  it('builds safe JQL for keys, queues and free text', () => {
    const pairing = {
      accountId: 'a"1',
      label: 'x',
      createdAt: NOW,
      lastUsedAt: NOW,
      checkedAt: NOW,
      projects: [WEB],
    };
    expect(ticketJql(pairing, 'assigned', 'web-12')).toBe(
      'project in (10) AND key = "WEB-12" ORDER BY updated DESC',
    );
    expect(ticketJql(pairing, 'queued', 'pill "button" OR 1=1')).toBe(
      'project in (10) AND guijamStatus = "queued" AND text ~ "pill button OR 1=1*" ORDER BY updated DESC',
    );
    expect(ticketJql(pairing, 'assigned', '')).toContain('assignee = "a\\"1"');
  });

  it('returns a ticket as plain text and hides tickets outside the pairing', async () => {
    const { deps, jira } = await setup();
    jira.add(issue('WEB-1', WEB.id)).add(issue('SEC-3', '30'));
    jira.grants = { BROWSE_PROJECTS: ['1001', '1003'] };
    expect(parsed(await handle(request('GET', '/v1/tickets/WEB-1'), deps)).data).toMatchObject({
      key: 'WEB-1',
      description: 'Fix WEB-1.',
      transitions: [{ id: '31', name: 'In Review' }],
    });
    expect(parsed(await handle(request('GET', '/v1/tickets/SEC-3'), deps))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(parsed(await handle(request('GET', '/v1/tickets/nope'), deps)).status).toBe(400);
  });

  it('serves only image attachments of that ticket, within the size cap', async () => {
    const { deps, jira } = await setup();
    jira.add(
      issue('WEB-1', WEB.id, {
        attachments: [
          { id: '7', filename: 'mock.png', mimeType: 'image/png', size: 14 },
          { id: '8', filename: 'notes.pdf', mimeType: 'application/pdf', size: 10 },
          { id: '9', filename: 'huge.png', mimeType: 'image/png', size: 9_000_000 },
        ],
      }),
    );
    jira.grants = { BROWSE_PROJECTS: ['1001'] };
    jira.contents.set('7', { mimeType: 'image/png', bytes: Buffer.from('fake-png-bytes') });
    expect(
      parsed(await handle(request('GET', '/v1/tickets/WEB-1/attachments/7'), deps)).data,
    ).toEqual({
      mediaType: 'image/png',
      base64: PNG,
    });
    expect(
      parsed(await handle(request('GET', '/v1/tickets/WEB-1/attachments/8'), deps)).status,
    ).toBe(404);
    expect(
      parsed(await handle(request('GET', '/v1/tickets/WEB-1/attachments/9'), deps)).status,
    ).toBe(413);
    expect(
      parsed(await handle(request('GET', '/v1/tickets/WEB-1/attachments/123'), deps)).status,
    ).toBe(404);
  });
});

describe('posting results', () => {
  const writer = {
    BROWSE_PROJECTS: ['1001'],
    ADD_COMMENTS: ['1001'],
    CREATE_ATTACHMENTS: ['1001'],
    EDIT_ISSUES: ['1001'],
    TRANSITION_ISSUES: ['1001'],
  };

  it('marks a ticket in progress when a developer links it', async () => {
    const { deps, jira } = await setup();
    jira.add(issue('WEB-1', WEB.id));
    jira.grants = writer;
    const body = { pageUrl: 'http://localhost:5173/', src: 'src/App.tsx:12:7' };
    expect(
      (await handle(request('POST', '/v1/tickets/WEB-1/start', { body }), deps)).statusCode,
    ).toBe(200);
    expect(jira.properties.get('WEB-1')).toEqual({
      status: 'in_progress',
      pageUrl: 'http://localhost:5173/',
      src: 'src/App.tsx:12:7',
      by: ACCOUNT,
    });
  });

  it('uploads before and after, comments, records the result, moves the ticket, once', async () => {
    const { deps, jira, store } = await setup();
    jira.add(issue('WEB-1', WEB.id));
    jira.grants = writer;
    const post = () =>
      handle(
        request('POST', '/v1/tickets/WEB-1/result', { body: result('j1', { transitionId: '31' }) }),
        deps,
      );
    expect(parsed(await post())).toEqual({
      status: 200,
      ok: true,
      data: { key: 'WEB-1', url: 'https://acme.atlassian.net/browse/WEB-1' },
    });
    expect(jira.uploads.map((upload) => upload.filename)).toEqual([
      'guijam-before-1.jpg',
      'guijam-after-1.jpg',
    ]);
    expect(jira.comments).toHaveLength(1);
    expect(JSON.stringify(jira.comments[0]?.body)).toContain(
      '"type":"mention","attrs":{"id":"acct-1"}',
    );
    expect(JSON.stringify(jira.comments[0]?.body)).toContain('@@ src/App.tsx:12');
    expect(jira.properties.get('WEB-1')).toMatchObject({
      status: 'applied',
      file: 'src/App.tsx:12',
      journalId: 'j1',
    });
    expect(await store.get('result:1001')).toMatchObject({
      journalId: 'j1',
      before: ['501'],
      after: ['502'],
      status: 'applied',
    });
    expect(jira.transitions).toEqual([{ key: 'WEB-1', id: '31' }]);

    await post();
    expect(jira.uploads).toHaveLength(2);
    expect(jira.comments).toHaveLength(1);
  });

  it('attaches the full patch when the change is too long to show inline', async () => {
    const { deps, jira } = await setup();
    jira.add(issue('WEB-1', WEB.id));
    jira.grants = writer;
    const long = Array.from({ length: 150 }, (_, line) => `line ${line}`);
    const body = result('j2', {
      changes: [{ file: 'src/App.tsx', line: 1, before: long, after: long }],
      before: [],
      after: [],
    });
    await handle(request('POST', '/v1/tickets/WEB-1/result', { body }), deps);
    expect(jira.uploads.map((upload) => upload.filename)).toEqual(['guijam-j2.patch']);
    expect(JSON.stringify(jira.comments[0]?.body)).toContain('guijam-j2.patch');
  });

  it("refuses to post where the person can't comment, even if the app could", async () => {
    const { deps, jira } = await setup();
    jira.add(issue('WEB-1', WEB.id));
    jira.grants = { BROWSE_PROJECTS: ['1001'] };
    const answer = parsed(
      await handle(request('POST', '/v1/tickets/WEB-1/result', { body: result() }), deps),
    );
    expect(answer).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(jira.uploads).toEqual([]);
    expect(jira.comments).toEqual([]);
  });

  it('uses the pairing project rights when the check is unavailable', async () => {
    const { deps, jira } = await setup();
    jira.add(issue('OPS-1', OPS.id));
    jira.grants = 'unavailable';
    expect(
      parsed(await handle(request('POST', '/v1/tickets/OPS-1/result', { body: result() }), deps))
        .status,
    ).toBe(403);
  });

  it('marks the ticket reverted only for the change that was posted', async () => {
    const { deps, jira, store } = await setup();
    jira.add(issue('WEB-1', WEB.id));
    jira.grants = writer;
    await handle(request('POST', '/v1/tickets/WEB-1/result', { body: result('j1') }), deps);
    await handle(
      request('POST', '/v1/tickets/WEB-1/reverted', { body: { journalId: 'other' } }),
      deps,
    );
    expect(jira.comments).toHaveLength(1);
    await handle(
      request('POST', '/v1/tickets/WEB-1/reverted', { body: { journalId: 'j1' } }),
      deps,
    );
    expect(jira.comments).toHaveLength(2);
    expect(jira.properties.get('WEB-1')).toMatchObject({ status: 'reverted' });
    expect(await store.get('result:1001')).toMatchObject({ status: 'reverted' });
  });
});

describe('reporting from GUIJam', () => {
  const report = {
    project: 'WEB',
    summary: 'The Subscribe button is cut off',
    description: 'On narrow screens.\n\nSee the screenshot.',
    pageUrl: 'http://localhost:5173/pricing',
    src: 'src/Pricing.tsx:40:9',
    image: { mediaType: 'image/png', base64: PNG },
  };

  it('creates a ticket with the screenshot, file and page, and queues it', async () => {
    const { deps, jira } = await setup();
    jira.grants = { CREATE_ISSUES: ['10'], CREATE_ATTACHMENTS: ['10'] };
    const answer = parsed(await handle(request('POST', '/v1/tickets', { body: report }), deps));
    expect(answer.data).toEqual({ key: 'WEB-99', url: 'https://acme.atlassian.net/browse/WEB-99' });
    expect(jira.uploads).toEqual([
      { key: 'WEB-99', filename: 'guijam-element.png', mimeType: 'image/png', size: 14 },
    ]);
    const text = JSON.stringify(jira.created[0]?.description);
    expect(text).toContain('src/Pricing.tsx:40');
    expect(text).toContain('http://localhost:5173/pricing');
    expect(jira.properties.get('WEB-99')).toMatchObject({ status: 'queued' });
  });

  it("refuses projects outside the pairing or where the person can't create", async () => {
    const { deps, jira } = await setup();
    jira.grants = { CREATE_ISSUES: [] };
    expect(
      parsed(await handle(request('POST', '/v1/tickets', { body: report }), deps)).status,
    ).toBe(403);
    expect(
      parsed(
        await handle(request('POST', '/v1/tickets', { body: { ...report, project: 'SEC' } }), deps),
      ).status,
    ).toBe(403);
    expect(jira.created).toEqual([]);
  });
});

describe('routing', () => {
  it('reads the route from userPath or from the end of the path', () => {
    expect(routeOf({ method: 'GET', userPath: '/v1/whoami', headers: {} })).toBe('/v1/whoami');
    expect(routeOf({ method: 'GET', path: '/x1/abc/v1/tickets/WEB-1', headers: {} })).toBe(
      '/v1/tickets/WEB-1',
    );
  });

  it('answers unknown routes with 404 and Jira failures with a readable error', async () => {
    const { deps, jira } = await setup();
    expect(parsed(await handle(request('DELETE', '/v1/tickets'), deps)).status).toBe(404);
    jira.issue = async () => {
      throw new (await import('../src/jira')).JiraError(500, 'Jira is down.');
    };
    expect(parsed(await handle(request('GET', '/v1/tickets/WEB-1'), deps))).toMatchObject({
      status: 502,
      code: 'JIRA_ERROR',
      message: 'Jira is down.',
    });
  });
});
