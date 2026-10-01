// Hand-written ambient types for @swfte/sdk.
declare module '@swfte/sdk' {
  export default class Swfte {
    constructor(config: { apiKey: string });
    workflows: {
      invoke(workflowId: string, inputs?: Record<string, unknown>): Promise<{ executionId: string }>;
    };
    agents: {
      chat(agentId: string, message: string): Promise<{ response: string }>;
    };
  }
}
