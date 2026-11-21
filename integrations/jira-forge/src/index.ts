import type { WebTriggerRequest, WebTriggerResponse } from '@forge/api';
import Resolver from '@forge/resolver';
import { forgeJira } from './jira';
import { defineResolvers } from './resolvers';
import { type BridgeRequest, handle } from './router';
import { forgeStore } from './store';
import { guijamResult, listUiTickets, type ToolInput } from './tools';

export async function bridge(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  return handle(request as BridgeRequest, {
    jira: forgeJira(),
    store: forgeStore,
    now: Date.now,
  });
}

export const handler = defineResolvers(new Resolver()).getDefinitions();

export async function listUiTicketsTool(input: ToolInput) {
  return listUiTickets(input);
}

export async function guijamResultTool(input: ToolInput) {
  return guijamResult(input);
}
