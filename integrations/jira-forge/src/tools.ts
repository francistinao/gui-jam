import api, { route } from '@forge/api';
import { forgeJira } from './jira';
import type { GuijamProperty, ResultRecord } from './router';
import { forgeStore, type Store } from './store';

const KEY = /^[A-Z][A-Z0-9_]*-[0-9]+$/;
const STATUSES = ['queued', 'in_progress', 'applied', 'reverted'] as const;
const LIMIT = 20;

export interface ToolInput {
  status?: unknown;
  issueKey?: unknown;
}

interface SearchRow {
  key: string;
  fields?: { summary?: string; status?: { name?: string } };
  properties?: { guijam?: GuijamProperty };
}

export function uiTicketsJql(status: unknown): string {
  const wanted = STATUSES.find((entry) => entry === status);
  const filter = wanted
    ? `= "${wanted}"`
    : `in (${STATUSES.map((entry) => `"${entry}"`).join(', ')})`;
  return `guijamStatus ${filter} ORDER BY updated DESC`;
}

export async function listUiTickets(input: ToolInput) {
  const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jql: uiTicketsJql(input?.status),
      maxResults: LIMIT,
      fields: ['summary', 'status'],
      properties: ['guijam'],
    }),
  });
  if (!response.ok) return { tickets: [], error: `Jira answered ${response.status}.` };
  const page = (await response.json()) as { issues?: SearchRow[] };
  return {
    tickets: (page.issues ?? []).map((issue) => ({
      key: issue.key,
      summary: issue.fields?.summary ?? '',
      status: issue.fields?.status?.name ?? '',
      guijam: issue.properties?.guijam?.status ?? 'none',
      file: issue.properties?.guijam?.file ?? null,
    })),
  };
}

export async function guijamResult(input: ToolInput, store: Store = forgeStore) {
  const key = typeof input?.issueKey === 'string' ? input.issueKey.trim().toUpperCase() : '';
  if (!KEY.test(key)) return { error: 'Give a ticket key such as WEB-12.' };
  const jira = forgeJira(api.asUser());
  const issue = await jira.issue(key);
  if (!issue) return { error: `${key} doesn't exist, or you can't see it.` };
  const property = (await jira.property<GuijamProperty>(key)) ?? null;
  const record = (await store.get<ResultRecord>(`result:${issue.id}`)) ?? null;
  return {
    key,
    summary: issue.summary,
    guijam: property?.status ?? 'none',
    result: record
      ? {
          status: record.status,
          appliedAt: record.appliedAt,
          agent: record.agent,
          element: record.src,
          files: record.files,
          diff: record.diff,
          screenshots: { before: record.before, after: record.after },
        }
      : null,
  };
}
