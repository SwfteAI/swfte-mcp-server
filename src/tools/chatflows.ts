import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({
  workspaceId: z.string().optional(),
});

const SessionInput = Workspace.extend({
  sessionId: z.string().min(1),
  operationId: z.string().trim().min(1).max(128),
  input: z.string(),
  inputType: z.enum(['TEXT', 'VOICE_TRANSCRIPT', 'DTMF', 'SESSION_START']).default('TEXT'),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const OperationIdentity = Workspace.extend({ sessionId: z.string().min(1), operationId: z.string().trim().min(1).max(128) }).strict();
const AbandonOperation = OperationIdentity.extend({ confirm: z.literal(true), reason: z.string().trim().min(8).max(500) }).strict();
const OperationReceipt = z.object({
  sessionId: z.string(), operationId: z.string(), status: z.enum(['COMPLETED', 'IN_FLIGHT', 'OPERATOR_ABANDONED']),
  message: z.string().nullable().optional(), canAbandon: z.boolean(), startNewSession: z.boolean(), reason: z.string().nullable().optional(),
});
function operationPath(sessionId: string, operationId: string) {
  return `/v2/chatflows/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}`;
}
function operationReceipt(value: unknown, sessionId: string, operationId: string) {
  const receipt = OperationReceipt.parse(value);
  if (receipt.sessionId !== sessionId || receipt.operationId !== operationId) throw new Error('Operation receipt identity mismatch');
  return receipt;
}

export const chatFlowTools: ToolDefinition[] = [
  {
    name: 'swfte_chatflows_list',
    title: 'List chatflows',
    description: 'List chatflows in the workspace.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/chatflows',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_get',
    title: 'Get chatflow',
    description: 'Fetch a chatflow definition by ID.',
    inputSchema: Workspace.extend({ chatFlowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_create',
    title: 'Create chatflow',
    description: 'Create a new chatflow definition.',
    inputSchema: Workspace.extend({ chatFlow: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/chatflows',
        body: input.chatFlow,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_validate',
    title: 'Validate chatflow definition',
    description: 'Validate a chatflow without persisting changes.',
    inputSchema: Workspace.extend({ chatFlowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/validate`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_deploy',
    title: 'Deploy chatflow',
    description: 'Deploy a chatflow so live sessions can use it.',
    inputSchema: Workspace.extend({ chatFlowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/deploy`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_publish',
    title: 'Publish chatflow as widget',
    description: 'Publish a chatflow and produce a Swfte Widget configuration usable by the chat-flow widget SDK.',
    inputSchema: Workspace.extend({
      chatFlowId: z.string(),
      publishConfig: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/publish`,
        body: input.publishConfig ?? {},
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_session_start',
    title: 'Start a chatflow session',
    description: 'Start a new conversational session for a deployed chatflow.',
    inputSchema: Workspace.extend({
      chatFlowId: z.string(),
      channel: z.enum(['WEB_CHAT', 'WHATSAPP', 'TELEGRAM', 'VOICE', 'WIDGET']).optional(),
      userId: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/sessions`,
        body: { channel: input.channel ?? 'WEB_CHAT', userId: input.userId, metadata: input.metadata },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_session_input',
    title: 'Submit one idempotent chatflow turn',
    description: 'Process input in an existing workspace chatflow session. operationId is a required logical turn ID: reuse the exact ID and input after a timeout or delivery retry, and use a new ID for a new turn. This may consume credits. Never change the text while reusing an ID. No automatic mutation retries; inspect the session after an ambiguous result. Inspect swfte_chatflows_operation_status after an ambiguous result. TURN_LIMIT_REACHED (409) requires a new session. Requires the backend durable turn receipt implementation.',
    inputSchema: SessionInput,
    execute: async (raw, { client }) => {
      const { sessionId, workspaceId, ...body } = SessionInput.parse(raw);
      return client.request({ method: 'POST', path: `/v2/chatflows/sessions/${encodeURIComponent(sessionId)}/input`, body, workspaceId, retries: 0 });
    },
  },
  {
    name: 'swfte_chatflows_operation_status',
    title: 'Inspect a chatflow turn receipt',
    description: 'Read one durable operation receipt after a timeout or ambiguous input result; requires workspace READ permission. Status is COMPLETED, IN_FLIGHT or OPERATOR_ABANDONED; unknown operations return 404. This does not execute or charge another turn. IN_FLIGHT is not proof of failure: inspect canAbandon, which requires at least 60 seconds and no live processing lock on the server. Never abandon automatically. After OPERATOR_ABANDONED, or input failure TURN_LIMIT_REACHED (409), start a new session. Completed results can be recovered by retrying the same original input and operationId; do not invent a new ID to bypass an in-flight turn.',
    inputSchema: OperationIdentity,
    readOnly: true,
    execute: async (raw, { client }) => {
      const { sessionId, operationId, workspaceId } = OperationIdentity.parse(raw);
      return operationReceipt(await client.request({ method: 'GET', path: operationPath(sessionId, operationId), workspaceId, retries: 1 }), sessionId, operationId);
    },
  },
  {
    name: 'swfte_chatflows_operation_abandon',
    title: 'Explicitly abandon an interrupted chatflow turn',
    description: 'Human-authorized administrative recovery only: require explicit confirm:true and the human-provided 8–500 character reason. Requires workspace ADMIN permission. Inspect swfte_chatflows_operation_status first; the server allows abandonment only after at least 60 seconds with no live processing lock, and returns 409 if state changed or execution is still active. Never auto-abandon, automatically retry, or treat a timeout as permission. This seals and ends the session without replaying input or initiating another turn charge; it does not refund existing usage. After confirmed OPERATOR_ABANDONED, start a new session. Unknown operation returns 404.',
    inputSchema: AbandonOperation,
    destructive: true,
    execute: async (raw, { client }) => {
      const { sessionId, operationId, workspaceId, reason } = AbandonOperation.parse(raw);
      const receipt = operationReceipt(await client.request({ method: 'POST', path: `${operationPath(sessionId, operationId)}/abandon`, body: { reason }, workspaceId, retries: 0 }), sessionId, operationId);
      if (receipt.status !== 'OPERATOR_ABANDONED' || receipt.startNewSession !== true) throw new Error('Abandonment was not confirmed; inspect operation status before further action');
      return receipt;
    },
  },
  {
    name: 'swfte_chatflows_session_get',
    title: 'Get chatflow session',
    description: 'Fetch the state of a chatflow session.',
    inputSchema: Workspace.extend({ sessionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/chatflows/sessions/${encodeURIComponent(input.sessionId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_builder_templates',
    title: 'List chatflow builder templates',
    description: 'List the chatflow templates available in the builder.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/chatflows/builder/templates',
        workspaceId: input.workspaceId,
      }),
  },
];
