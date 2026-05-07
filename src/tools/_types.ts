import type { z, ZodTypeAny } from 'zod';
import type { SwfteClient } from '../client.js';

export interface ToolContext {
  client: SwfteClient;
}

export interface ToolDefinition<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  title?: string;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}
