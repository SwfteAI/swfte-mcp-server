// Local type stub for @swfte/sdk 1.1.x (only the surface this app uses), mapped via tsconfig "paths".
export interface SwfteConfig {
  apiKey: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  workspaceId?: string;
}

export interface WorkflowInvokeResponse {
  executionId: string;
  workflowId?: string;
  status?: string;
}

export interface WorkflowExecution {
  id: string;
  executionId?: string;
  workflowId: string;
  status: string;
  outputs?: Record<string, any>;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowExecutionStatus {
  executionId: string;
  status: string;
  progress?: number;
  outputs?: any;
  error?: string;
  paused?: boolean;
}

export interface InvokeAndWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  throwOnPause?: boolean;
}

export interface AgentChatOptions {
  userId?: string;
  conversationId?: string;
}

export interface AgentChatResponse {
  response: string;
  conversationId: string | null;
  model?: string;
}

export interface ChatFlowSession {
  id: string;
  chatflowId: string;
  status: string;
}

export declare class Workflows {
  invoke(workflowId: string, inputs?: Record<string, unknown>): Promise<WorkflowInvokeResponse>;
  invokeAndWait(workflowId: string, inputs?: Record<string, unknown>, options?: InvokeAndWaitOptions): Promise<WorkflowExecutionStatus>;
  execute(workflowId: string, inputs?: Record<string, unknown>, skipValidation?: boolean): Promise<WorkflowExecution>;
  getExecutionStatus(executionId: string): Promise<WorkflowExecutionStatus>;
  getExecutionHistory(workflowId: string): Promise<WorkflowExecution[]>;
  create(params: { name: string; nodes?: unknown[]; edges?: unknown[] }): Promise<{ id: string; name: string }>;
}

export declare class Agents {
  chat(agentId: string, message: string, options?: AgentChatOptions): Promise<AgentChatResponse>;
  get(agentId: string): Promise<{ id: string; name: string }>;
  list(page?: number, size?: number): Promise<Array<{ id: string; name: string }>>;
}

export declare class ChatFlows {
  startSession(id: string, params?: { channel?: string; metadata?: Record<string, unknown> }): Promise<ChatFlowSession>;
  listSessions(id: string, params?: { page?: number; size?: number; status?: string }): Promise<ChatFlowSession[]>;
  stats(id: string): Promise<{ sessions: number; completed: number; completionRate: number }>;
}

export declare class Chat {
  completions: {
    create(params: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ choices: Array<{ message: { content: string } }> }>;
  };
}

export declare class SwfteClient {
  constructor(config: SwfteConfig);
  readonly chat: Chat;
  readonly agents: Agents;
  readonly workflows: Workflows;
  readonly chatflows: ChatFlows;
}

export { SwfteClient as Swfte };
export default SwfteClient;
