import api, { route, webTrigger } from '@forge/api';
import type Resolver from '@forge/resolver';
import { forgeJira, type Permission } from './jira';
import {
  type AllowedProject,
  createPairing,
  type Device,
  devices,
  lastChecked,
  refreshProjects,
  revoke,
} from './pairing';
import type { GuijamProperty, ResultRecord } from './router';
import { forgeStore, type Store } from './store';

export const BRIDGE_KEY = 'guijam-bridge';
const REFRESH_MS = 10 * 60 * 1000;
const PROJECTS = 50;
const POST: Permission[] = [
  'ADD_COMMENTS',
  'CREATE_ATTACHMENTS',
  'EDIT_ISSUES',
  'TRANSITION_ISSUES',
];

export interface PanelData {
  viewer: string;
  status: GuijamProperty['status'] | 'none';
  property: GuijamProperty | null;
  result: ResultRecord | null;
  devices: Device[];
}

type Request = Parameters<Parameters<Resolver['define']>[1]>[0];

function issueOf(request: Request): { id: string; key: string } | undefined {
  const issue = (request.context.extension as { issue?: { id?: unknown; key?: unknown } })?.issue;
  if (typeof issue?.id === 'undefined' || typeof issue?.key !== 'string') return undefined;
  return { id: String(issue.id), key: issue.key };
}

export async function userProjects(): Promise<AllowedProject[]> {
  const user = api.asUser();
  const listed = await user.requestJira(
    route`/rest/api/3/project/search?maxResults=${String(PROJECTS)}&orderBy=name`,
  );
  if (!listed.ok) return [];
  const found = ((await listed.json()) as { values?: { id: string; key: string; name: string }[] })
    .values;
  const projects = (found ?? []).map((project) => ({ ...project, id: String(project.id) }));
  if (projects.length === 0) return [];
  const ids = projects.map((project) => Number(project.id));
  const checked = await user.requestJira(route`/rest/api/3/permissions/check`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPermissions: [
        { permissions: POST, projects: ids },
        { permissions: ['CREATE_ISSUES'], projects: ids },
      ],
    }),
  });
  const granted = new Map<string, Set<string>>();
  if (checked.ok) {
    const answer = (await checked.json()) as {
      projectPermissions?: { permission: string; projects?: number[] }[];
    };
    for (const entry of answer.projectPermissions ?? []) {
      granted.set(entry.permission, new Set((entry.projects ?? []).map(String)));
    }
  }
  return projects.map((project) => ({
    id: project.id,
    key: project.key,
    name: project.name,
    post: POST.every((permission) => granted.get(permission)?.has(project.id)),
    create: granted.get('CREATE_ISSUES')?.has(project.id) ?? false,
  }));
}

export async function panelData(
  store: Store,
  accountId: string,
  issue: { id: string; key: string },
): Promise<PanelData> {
  const property = (await forgeJira(api.asUser()).property<GuijamProperty>(issue.key)) ?? null;
  const result = (await store.get<ResultRecord>(`result:${issue.id}`)) ?? null;
  const checkedAt = await lastChecked(store, accountId);
  if (checkedAt !== undefined && Date.now() - checkedAt > REFRESH_MS) {
    await refreshProjects(store, accountId, await userProjects(), Date.now());
  }
  return {
    viewer: accountId,
    status: property?.status ?? 'none',
    property,
    result,
    devices: await devices(store, accountId),
  };
}

export function defineResolvers(resolver: Resolver, store: Store = forgeStore): Resolver {
  resolver.define('panelData', async (request) => {
    const issue = issueOf(request);
    if (!issue) throw new Error('Open this panel on a ticket.');
    return panelData(store, request.context.accountId, issue);
  });

  resolver.define('pair', async (request) => {
    const payload = request.payload as { label?: unknown };
    const label = typeof payload?.label === 'string' ? payload.label : 'GUIJam';
    const url = await webTrigger.getUrl(BRIDGE_KEY);
    const projects = await userProjects();
    return createPairing(store, request.context.accountId, label, projects, url, Date.now());
  });

  resolver.define('revoke', async (request) => {
    const payload = request.payload as { deviceId?: unknown };
    if (typeof payload?.deviceId !== 'string') return { revoked: false };
    return { revoked: await revoke(store, request.context.accountId, payload.deviceId) };
  });

  resolver.define('queue', async (request) => {
    const issue = issueOf(request);
    if (!issue) throw new Error('Open this action on a ticket.');
    const jira = forgeJira(api.asUser());
    const current = await jira.property<GuijamProperty>(issue.key);
    if (current?.status === 'applied' || current?.status === 'in_progress') {
      return { status: current.status };
    }
    await jira.setProperty(issue.key, { ...current, status: 'queued' } satisfies GuijamProperty);
    return { status: 'queued' };
  });

  return resolver;
}
