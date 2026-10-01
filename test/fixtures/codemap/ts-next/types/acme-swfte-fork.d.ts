// Local type stub for @acme/swfte-fork, an internal fork of an old @swfte/sdk (not in swfte.json).
export declare class ForkClient {
  constructor(config: { token: string; host?: string });
  workflows: {
    invoke(workflowId: string, inputs?: Record<string, unknown>): Promise<{ executionId: string }>;
  };
  agents: {
    chat(agentId: string, message: string): Promise<{ response: string }>;
  };
}
