import api, { route } from '@forge/api';
import type { AdfDoc } from './adf';
import { multipartFile } from './multipart';

export type Permission =
  | 'BROWSE_PROJECTS'
  | 'ADD_COMMENTS'
  | 'CREATE_ATTACHMENTS'
  | 'EDIT_ISSUES'
  | 'TRANSITION_ISSUES'
  | 'CREATE_ISSUES';

export interface IssueRow {
  id: string;
  key: string;
  summary: string;
  status: string;
  type: string;
  projectId: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface Issue extends IssueRow {
  description: unknown;
  attachments: Attachment[];
  transitions: { id: string; name: string }[];
}

export interface Granted {
  issues: Set<string>;
  projects: Set<string>;
}

export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PermissionCheckUnavailable extends Error {}

export interface Jira {
  baseUrl(): Promise<string>;
  displayName(accountId: string): Promise<string>;
  search(jql: string, max: number): Promise<IssueRow[]>;
  issue(key: string): Promise<Issue | undefined>;
  attachment(id: string): Promise<{ mimeType: string; bytes: Uint8Array } | undefined>;
  upload(key: string, filename: string, mimeType: string, bytes: Uint8Array): Promise<string>;
  property<T>(key: string): Promise<T | undefined>;
  setProperty(key: string, value: unknown): Promise<void>;
  comment(key: string, body: AdfDoc): Promise<void>;
  transition(key: string, id: string): Promise<void>;
  createIssue(projectKey: string, summary: string, description: AdfDoc): Promise<IssueRow>;
  permissions(
    accountId: string,
    target: { issues?: string[]; projects?: string[] },
    permissions: Permission[],
  ): Promise<Map<Permission, Granted>>;
}

export const PROPERTY = 'guijam';

type Fetcher = typeof api.asApp extends () => infer R ? R : never;

interface RawIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    issuetype?: { name?: string };
    project?: { id?: string };
    attachment?: { id: string; filename: string; mimeType: string; size: number }[];
  };
  transitions?: { id: string; name: string }[];
}

function row(raw: RawIssue): IssueRow {
  return {
    id: String(raw.id),
    key: raw.key,
    summary: raw.fields?.summary ?? '',
    status: raw.fields?.status?.name ?? '',
    type: raw.fields?.issuetype?.name ?? '',
    projectId: String(raw.fields?.project?.id ?? ''),
  };
}

async function failed(response: { status: number; text(): Promise<string> }): Promise<never> {
  const body = await response.text().catch(() => '');
  let message = `Jira answered ${response.status}.`;
  try {
    const parsed = JSON.parse(body) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    const first = parsed.errorMessages?.[0] ?? Object.values(parsed.errors ?? {})[0];
    if (first) message = first;
  } catch {}
  throw new JiraError(response.status, message);
}

export function forgeJira(as: Fetcher = api.asApp()): Jira {
  const json = { Accept: 'application/json', 'Content-Type': 'application/json' };
  return {
    async baseUrl() {
      const response = await as.requestJira(route`/rest/api/3/serverInfo`);
      if (!response.ok) return failed(response);
      return ((await response.json()) as { baseUrl: string }).baseUrl;
    },

    async displayName(accountId) {
      const response = await as.requestJira(route`/rest/api/3/user?accountId=${accountId}`);
      if (!response.ok) return 'Someone';
      return ((await response.json()) as { displayName?: string }).displayName ?? 'Someone';
    },

    async search(jql, max) {
      const response = await as.requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          jql,
          maxResults: max,
          fields: ['summary', 'status', 'issuetype', 'project'],
        }),
      });
      if (!response.ok) return failed(response);
      const page = (await response.json()) as { issues?: RawIssue[] };
      return (page.issues ?? []).map(row);
    },

    async issue(key) {
      const response = await as.requestJira(
        route`/rest/api/3/issue/${key}?fields=summary,description,status,issuetype,project,attachment&expand=transitions`,
      );
      if (response.status === 404) return undefined;
      if (!response.ok) return failed(response);
      const raw = (await response.json()) as RawIssue;
      return {
        ...row(raw),
        description: raw.fields?.description ?? null,
        attachments: (raw.fields?.attachment ?? []).map((entry) => ({
          id: String(entry.id),
          filename: entry.filename,
          mimeType: entry.mimeType,
          size: entry.size,
        })),
        transitions: (raw.transitions ?? []).map((entry) => ({
          id: String(entry.id),
          name: entry.name,
        })),
      };
    },

    async attachment(id) {
      const response = await as.requestJira(route`/rest/api/3/attachment/content/${id}`);
      if (response.status === 404) return undefined;
      if (!response.ok) return failed(response);
      const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      return { mimeType, bytes: new Uint8Array(await response.arrayBuffer()) };
    },

    async upload(key, filename, mimeType, bytes) {
      const form = multipartFile('file', filename, mimeType, bytes);
      const response = await as.requestJira(route`/rest/api/3/issue/${key}/attachments`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': form.contentType,
          'X-Atlassian-Token': 'no-check',
        },
        body: form.body,
      });
      if (!response.ok) return failed(response);
      const [created] = (await response.json()) as { id: string }[];
      if (!created) throw new JiraError(500, 'Jira did not return the attachment.');
      return String(created.id);
    },

    async property<T>(key: string) {
      const response = await as.requestJira(route`/rest/api/3/issue/${key}/properties/${PROPERTY}`);
      if (response.status === 404) return undefined;
      if (!response.ok) return failed(response);
      return ((await response.json()) as { value?: T }).value;
    },

    async setProperty(key, value) {
      const response = await as.requestJira(
        route`/rest/api/3/issue/${key}/properties/${PROPERTY}`,
        { method: 'PUT', headers: json, body: JSON.stringify(value) },
      );
      if (!response.ok) return failed(response);
    },

    async comment(key, body) {
      const response = await as.requestJira(route`/rest/api/3/issue/${key}/comment`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ body }),
      });
      if (!response.ok) return failed(response);
    },

    async transition(key, id) {
      const response = await as.requestJira(route`/rest/api/3/issue/${key}/transitions`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ transition: { id } }),
      });
      if (!response.ok) return failed(response);
    },

    async createIssue(projectKey, summary, description) {
      const types = await as.requestJira(
        route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
      );
      if (!types.ok) return failed(types);
      const listed = (await types.json()) as {
        issueTypes?: { id: string; name: string; subtask?: boolean }[];
      };
      const usable = (listed.issueTypes ?? []).filter((entry) => !entry.subtask);
      const type =
        usable.find((entry) => entry.name === 'Bug') ??
        usable.find((entry) => entry.name === 'Task') ??
        usable[0];
      if (!type) throw new JiraError(400, `${projectKey} has no issue type GUIJam can create.`);
      const response = await as.requestJira(route`/rest/api/3/issue`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            summary,
            description,
            issuetype: { id: type.id },
          },
        }),
      });
      if (!response.ok) return failed(response);
      const created = (await response.json()) as { id: string; key: string };
      return {
        id: String(created.id),
        key: created.key,
        summary,
        status: '',
        type: type.name,
        projectId: '',
      };
    },

    async permissions(accountId, target, permissions) {
      const response = await as.requestJira(route`/rest/api/3/permissions/check`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          accountId,
          projectPermissions: [
            {
              permissions,
              ...(target.issues ? { issues: target.issues.map(Number) } : {}),
              ...(target.projects ? { projects: target.projects.map(Number) } : {}),
            },
          ],
        }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new PermissionCheckUnavailable(`Jira answered ${response.status}.`);
      }
      if (!response.ok) return failed(response);
      const checked = (await response.json()) as {
        projectPermissions?: { permission: Permission; issues?: number[]; projects?: number[] }[];
      };
      const granted = new Map<Permission, Granted>();
      for (const entry of checked.projectPermissions ?? []) {
        granted.set(entry.permission, {
          issues: new Set((entry.issues ?? []).map(String)),
          projects: new Set((entry.projects ?? []).map(String)),
        });
      }
      return granted;
    },
  };
}
