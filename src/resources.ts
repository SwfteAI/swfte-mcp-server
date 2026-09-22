/**
 * MCP resources: read-only context a client can attach without a tool call.
 *
 *  - `swfte://capabilities`          what this server can do right now: advertised
 *                                    tools by group, kind lifecycle verbs, catalog
 *                                    kinds, evidence ladder and action capabilities.
 *                                    Local; makes no network call.
 *  - `swfte://catalog/{kind}/{id}`   the context package for one catalog artifact
 *                                    (the same payload as swfte_get_context).
 */
import type { SwfteClient } from './client.js';
import type { ServerConfig } from './config.js';
import {
  ACTION_CAPABILITIES,
  CATALOG_KINDS,
  EVIDENCE_LEVELS,
  getContextPackage,
  parseCatalogRef,
} from './catalog.js';
import type { ToolDefinition } from './tools/_types.js';

export const CAPABILITIES_URI = 'swfte://capabilities';
export const CATALOG_TEMPLATE = 'swfte://catalog/{kind}/{id}';

export const STATIC_RESOURCES = [
  {
    uri: CAPABILITIES_URI,
    name: 'Swfte capabilities',
    description:
      'Advertised tools by group, implemented kinds and their lifecycle verbs, catalog kinds, the evidence ladder and approval-gated action capabilities. Local; no network call.',
    mimeType: 'application/json',
  },
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: CATALOG_TEMPLATE,
    name: 'Catalog artifact context',
    description:
      'Context package for one Studio catalog artifact: contract (invoke, schemas, snippets, embed), evidence, facets, rationale, reviews and dependencies. kind is one of ' +
      `${CATALOG_KINDS.join(', ')}.`,
    mimeType: 'application/json',
  },
];

export class ResourceNotFoundError extends Error {}

/** `swfte://catalog/workflow/wf_1` -> "workflow:wf_1", or null for any other URI. */
export function catalogRefFromUri(uri: string): string | null {
  const m = /^swfte:\/\/catalog\/([a-z-]+)\/(.+)$/.exec(uri);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  if (!id || id.includes('/')) return null;
  return `${m[1]}:${id}`;
}

export async function readResource(
  uri: string,
  ctx: { client: () => Promise<SwfteClient>; config: ServerConfig; tools: ToolDefinition[] }
): Promise<{ uri: string; mimeType: string; text: string }> {
  if (uri === CAPABILITIES_URI) {
    const capabilitiesTool = ctx.tools.find((t) => t.name === 'swfte_capabilities');
    const local = capabilitiesTool
      ? await capabilitiesTool.execute({}, { client: undefined as unknown as SwfteClient, config: ctx.config })
      : null;
    const body = {
      server: '@swfte/mcp-server',
      reuseFirst:
        'Call swfte_find_existing before swfte_build. Reuse via swfte_get_context + swfte_scaffold_client; wire analytics/payments with swfte_wire_*; every platform mutation is an approval-gated action.',
      catalog: {
        kinds: CATALOG_KINDS,
        evidenceLevels: EVIDENCE_LEVELS,
        resourceTemplate: CATALOG_TEMPLATE,
      },
      actions: {
        capabilities: ACTION_CAPABILITIES,
        lifecycle: 'PROPOSED -> APPROVED (human, in Studio) -> EXECUTED; execute answers 409 until approved and 410 once expired.',
      },
      ...(local && typeof local === 'object' ? (local as Record<string, unknown>) : {}),
    };
    return { uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) };
  }
  const ref = catalogRefFromUri(uri);
  if (!ref) throw new ResourceNotFoundError(`Unknown resource ${uri}. Known: ${CAPABILITIES_URI}, ${CATALOG_TEMPLATE}.`);
  const pkg = await getContextPackage(await ctx.client(), parseCatalogRef(ref));
  return { uri, mimeType: 'application/json', text: JSON.stringify(pkg, null, 2) };
}
