import type { SwfteClient } from './client.js';
import type { ServerConfig } from './config.js';

/** Both an explicit local group and the authenticated backend gate are required. No shared cache. */
export async function learningEnabled(client: SwfteClient, config: ServerConfig): Promise<boolean> {
  if (!config.enabledGroups.has('learning')) return false;
  try {
    const flags = await client.request({ method: 'GET', path: '/v2/learning/capabilities', retries: 0 });
    return !!flags && typeof flags === 'object' && (flags as Record<string, unknown>).mcp === true;
  } catch { return false; }
}
