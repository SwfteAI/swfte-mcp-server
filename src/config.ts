export interface ServerConfig {
  apiKey: string;
  baseUrl: string;
  workspaceId?: string;
  userAgent: string;
  debug: boolean;
}

export function loadConfig(): ServerConfig {
  const apiKey = process.env.SWFTE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'SWFTE_API_KEY environment variable is required. Get one at https://www.swfte.com/settings/api-keys'
    );
  }

  return {
    apiKey,
    baseUrl: (process.env.SWFTE_BASE_URL ?? 'https://api.swfte.com/agents').replace(/\/$/, ''),
    workspaceId: process.env.SWFTE_WORKSPACE_ID,
    userAgent: `swfte-mcp-server/${process.env.SWFTE_MCP_VERSION ?? '0.1.0'} (+https://www.swfte.com)`,
    debug: process.env.SWFTE_DEBUG === '1' || process.env.SWFTE_DEBUG === 'true',
  };
}
