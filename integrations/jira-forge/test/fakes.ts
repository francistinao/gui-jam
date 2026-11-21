import type { AdfDoc } from '../src/adf';
import {
  type Granted,
  type Issue,
  type IssueRow,
  type Jira,
  type Permission,
  PermissionCheckUnavailable,
} from '../src/jira';
import { type AllowedProject, createPairing } from '../src/pairing';
import type { BridgeRequest, Deps } from '../src/router';
import { memoryStore } from '../src/store';

export const ACCOUNT = 'acct-1';
export const NOW = Date.UTC(2026, 10, 21, 3, 0, 0);
export const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';

export const WEB: AllowedProject = { id: '10', key: 'WEB', name: 'Web', post: true, create: true };
export const OPS: AllowedProject = {
  id: '20',
  key: 'OPS',
  name: 'Ops',
  post: false,
  create: false,
};

export function issue(key: string, projectId: string, extra: Partial<Issue> = {}): Issue {
  return {
    id: String(1000 + Number(key.split('-')[1])),
    key,
    summary: `Summary of ${key}`,
    status: 'To Do',
    type: 'Task',
    projectId,
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `Fix ${key}.` }] }],
    },
    attachments: [],
    transitions: [{ id: '31', name: 'In Review' }],
    ...extra,
  };
}

export class FakeJira implements Jira {
  issues = new Map<string, Issue>();
  properties = new Map<string, unknown>();
  comments: { key: string; body: AdfDoc }[] = [];
  uploads: { key: string; filename: string; mimeType: string; size: number }[] = [];
  transitions: { key: string; id: string }[] = [];
  created: { projectKey: string; summary: string; description: AdfDoc }[] = [];
  searches: string[] = [];
  contents = new Map<string, { mimeType: string; bytes: Uint8Array }>();
  grants: Partial<Record<Permission, string[]>> | 'unavailable' = {};

  add(entry: Issue): this {
    this.issues.set(entry.key, entry);
    return this;
  }

  async baseUrl() {
    return 'https://acme.atlassian.net';
  }

  async displayName() {
    return 'Francis';
  }

  async search(jql: string) {
    this.searches.push(jql);
    return [...this.issues.values()].map(
      ({ id, key, summary, status, type, projectId }): IssueRow => ({
        id,
        key,
        summary,
        status,
        type,
        projectId,
      }),
    );
  }

  async issue(key: string) {
    return this.issues.get(key);
  }

  async attachment(id: string) {
    return this.contents.get(id);
  }

  async upload(key: string, filename: string, mimeType: string, bytes: Uint8Array) {
    this.uploads.push({ key, filename, mimeType, size: bytes.length });
    return String(500 + this.uploads.length);
  }

  async property<T>(key: string) {
    return this.properties.get(key) as T | undefined;
  }

  async setProperty(key: string, value: unknown) {
    this.properties.set(key, value);
  }

  async comment(key: string, body: AdfDoc) {
    this.comments.push({ key, body });
  }

  async transition(key: string, id: string) {
    this.transitions.push({ key, id });
  }

  async createIssue(projectKey: string, summary: string, description: AdfDoc) {
    this.created.push({ projectKey, summary, description });
    return { id: '9001', key: `${projectKey}-99`, summary, status: '', type: 'Bug', projectId: '' };
  }

  async permissions(
    _accountId: string,
    target: { issues?: string[]; projects?: string[] },
    permissions: Permission[],
  ) {
    if (this.grants === 'unavailable') throw new PermissionCheckUnavailable('403');
    const granted = new Map<Permission, Granted>();
    for (const permission of permissions) {
      const allowed = new Set(this.grants[permission] ?? []);
      granted.set(permission, {
        issues: new Set((target.issues ?? []).filter((id) => allowed.has(id))),
        projects: new Set((target.projects ?? []).filter((id) => allowed.has(id))),
      });
    }
    return granted;
  }
}

export async function setup(projects: AllowedProject[] = [WEB, OPS]) {
  const store = memoryStore();
  const jira = new FakeJira();
  let now = NOW;
  const deps: Deps = { jira, store, now: () => now };
  await createPairing(store, ACCOUNT, 'Laptop', projects, 'https://trigger.example/x', NOW, TOKEN);
  return {
    store,
    jira,
    deps,
    advance(ms: number) {
      now += ms;
    },
  };
}

export function request(
  method: string,
  userPath: string,
  options: { body?: unknown; query?: Record<string, string>; token?: string | null } = {},
): BridgeRequest {
  const token = options.token === undefined ? TOKEN : options.token;
  return {
    method,
    userPath,
    headers: token ? { Authorization: [`Bearer ${token}`] } : {},
    queryParameters: Object.fromEntries(
      Object.entries(options.query ?? {}).map(([key, value]) => [key, [value]]),
    ),
    ...(options.body === undefined
      ? {}
      : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
  };
}

export function parsed(response: {
  statusCode: number;
  body: string;
}): { status: number } & Record<string, unknown> {
  return { status: response.statusCode, ...(JSON.parse(response.body) as Record<string, unknown>) };
}

export const PNG = Buffer.from('fake-png-bytes').toString('base64');
