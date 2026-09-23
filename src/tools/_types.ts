import type { z, ZodTypeAny } from 'zod';
import type { SwfteClient } from '../client.js';
import type { ServerConfig, ToolGroup } from '../config.js';

export interface ToolContext {
  client: SwfteClient;
  config: ServerConfig;
  /**
   * Whether this process runs inside the caller's project (stdio, launched by
   * the MCP client) and may read or write files there. False when hosted over
   * HTTP: the server's own disk is not the caller's codebase, so local-file
   * tools refuse. Absent means local.
   */
  localFilesystem?: boolean;
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
