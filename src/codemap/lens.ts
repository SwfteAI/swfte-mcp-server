import type { SwfteClient } from '../client.js';
import { CALLSITE_ID_PATTERN, PATH_HASH_PATTERN, REPO_ID_PATTERN } from './types.js';

export const CODEMAP_LENS_TEMPLATE = 'swfte://codemap/{repoId}/file/{path}';
export const lensEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SWFTE_CODEMAP_LENS === '1';

export function parseLensUri(uri: string): { repoId: string; path?: string; pathHash?: string } | null {
  const match = /^swfte:\/\/codemap\/(r_[0-9a-f]{32})\/file\/([^?#]+)$/.exec(uri);
  if (!match) return null;
  let path: string;
  try { path = decodeURIComponent(match[2]!); } catch { return null; }
  if (PATH_HASH_PATTERN.test(path)) return { repoId: match[1]!, pathHash: path };
  if (!/^[A-Za-z0-9._/@+()\[\]~-]{1,400}$/.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.')) return null;
  return { repoId: match[1]!, path };
}

/** A resource is exactly the authenticated read API projection; no local source lookup exists. */
export async function readCodeMapLens(client: SwfteClient, query: { repoId: string; path?: string; pathHash?: string }): Promise<unknown> {
  if (!REPO_ID_PATTERN.test(query.repoId) || (query.path === undefined) === (query.pathHash === undefined)
    || (query.pathHash !== undefined && !PATH_HASH_PATTERN.test(query.pathHash))) throw new Error('Invalid code-map lens query.');
  const result = await client.request<{ items: Array<Record<string, unknown>> }>({ method: 'GET', path: '/v2/codemap/lens', query });
  if (!result || !Array.isArray(result.items) || result.items.some(item => !item || typeof item.callSiteId !== 'string' || !CALLSITE_ID_PATTERN.test(item.callSiteId))) {
    throw new Error('Invalid code-map lens receipt.');
  }
  return result;
}
