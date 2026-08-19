import type { z, ZodTypeAny } from 'zod';
import type { SwfteClient } from '../client.js';
import type { ServerConfig, ToolGroup } from '../config.js';

export interface ToolContext {
  client: SwfteClient;
  config: ServerConfig;
}

export interface ToolDefinition<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  title?: string;
  description: string;
  /**
   * Group this tool belongs to, for `SWFTE_TOOLS` filtering. Tools without a
   * group are always advertised.
   */
  group?: ToolGroup;
  inputSchema: S;
  /**
   * Hints for MCP clients that surface them. `readOnly` lets a client skip
   * confirmation prompts; `destructive` earns one.
   */
  readOnly?: boolean;
  destructive?: boolean;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

/** Convenience for the many tools whose only optional input is a workspace override. */
export type { ToolGroup };
