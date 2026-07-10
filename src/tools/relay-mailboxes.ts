import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const relayMailboxTools: ToolDefinition[] = [
  {
    name: 'swfte_relay_mailboxes_get_profile',
    title: 'Resolve a connected mailbox address',
    description: 'Resolve the real email address of a just-connected Gmail secret (returned by the OAuth flow as secretId). Use this to auto-fill a journey\'s inbound-email trigger with the address it will actually receive/reply from. There is no separate mailbox-binding resource — a mailbox is bound to a journey by setting definitionJson.trigger = {type:"email", email, secretId} and then deploying the journey with swfte_journeys_deploy; the backend provisions the inbound-email route at that point.',
    inputSchema: Workspace.extend({ secretId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/mailbox/profile',
        query: { secretId: input.secretId },
        workspaceId: input.workspaceId,
      }),
  },
];
