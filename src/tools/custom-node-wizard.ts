import { z } from 'zod';
import type { ToolDefinition } from './_types.js';
const id = () => z.string().trim().min(1).max(200).refine(v => v !== '.' && v !== '..', 'Invalid identifier');
const base = (workspaceId: string) => `/v2/workspaces/${encodeURIComponent(workspaceId)}/custom-nodes`;

/** A finite wizard stream must contain a terminal event. Never retry a generation GET. */
export function customNodeTerminal(raw: unknown, autoCreate: boolean): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error('Expected custom-node wizard SSE response');
  for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') throw new Error('Custom-node stream ended without a terminal result; inspect custom nodes before retrying');
    const event = JSON.parse(data);
    if (event.status === 'error') return { ...event, error: event.error || event.message || 'Custom-node generation failed' };
    if (event.status === 'completed') {
      if (!event.generatedNode || (autoCreate && !event.createdNode?.id)) throw new Error('Custom-node completion is missing the generated/persisted artifact; inspect custom nodes before retrying');
      return event;
    }
  }
  throw new Error('Custom-node stream ended without a terminal result; inspect custom nodes before retrying');
}
export const customNodeWizardTools: ToolDefinition[] = [
  {
    name: 'swfte_custom_nodes_list', readOnly: true,
    description: 'List custom nodes in the authenticated workspace; reconcile persisted results after a generation timeout before retrying.',
    inputSchema: z.object({ workspaceId: id() }),
    execute: async (input, { client }) => client.request({ method: 'GET', path: base(input.workspaceId), workspaceId: input.workspaceId, retries: 1 }),
  },
  {
    name: 'swfte_custom_nodes_generate',
    description: 'Generate a custom workflow node from PROMPT, DOC, URL, or a small base64 SCREENSHOT. Optional autoCreate persists it. This starts a billable generation even though the backend uses GET; never retry automatically. Input is query transported, limited to 6000 characters.',
    inputSchema: z.object({ workspaceId: id(), mode: z.enum(['PROMPT', 'DOC', 'URL', 'SCREENSHOT']), input: z.string().trim().min(1).max(6000),
      autoCreate: z.boolean().default(false), model: z.string().min(1).optional() }),
    execute: async (input, { client }) => customNodeTerminal(await client.request({
      method: 'GET', path: `${base(input.workspaceId)}/wizard/generate/stream`, workspaceId: input.workspaceId,
      query: { mode: input.mode, input: input.input, autoCreate: input.autoCreate, model: input.model },
      headers: { Accept: 'text/event-stream' }, retries: 0, timeoutMs: 300_000,
    }), input.autoCreate),
  },
  ...(['get', 'delete'] as const).map(action => ({
    name: `swfte_custom_nodes_${action}`, description: `${action === 'get' ? 'Read' : 'Delete'} a persisted custom workflow node.`,
    inputSchema: z.object({ workspaceId: id(), nodeId: id() }), readOnly: action === 'get', destructive: action === 'delete',
    execute: async (input: any, { client }: any) => client.request({ method: action === 'get' ? 'GET' : 'DELETE',
      path: `${base(input.workspaceId)}/${encodeURIComponent(input.nodeId)}`, workspaceId: input.workspaceId, retries: action === 'get' ? 1 : 0 }),
  })),
];
