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
import { fetchRecipe, fetchRecipePage, LearningBookNotFoundError, requireLearning } from './tools/recipes.js';
import type { LearningKind } from './learning-contract.js';

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

const BOOK_KINDS = ['recipe','fragment','playbook'] as const;
const BOOK_PATHS = {recipe:'recipes',fragment:'fragments',playbook:'playbooks'} as const;
export const LEARNING_RESOURCE_TEMPLATES = BOOK_KINDS.map(kind => ({
  uriTemplate:`swfte://${BOOK_PATHS[kind]}/{id}`,name:`Grounded ${kind}`,
  description:'Current quoted data with backend evidence and replay provenance. Read-only; missing, foreign, stale and off are indistinguishable.',mimeType:'application/json',
}));

/** One bounded backend page per kind. The continuation is opaque and each backend cursor binds its tenant. */
export async function listLearningResources(client:SwfteClient,config:ServerConfig,cursor?:string):Promise<{
  resources:{uri:string;name:string;description:string;mimeType:string}[];nextCursor?:string;
}> {
  try {
    await requireLearning(client,config);
    let state:{page:number;cursors:Partial<Record<LearningKind,string|null>>} = {page:0,cursors:{}};
    if (cursor !== undefined) {
      if (cursor.length > 8192) throw new LearningBookNotFoundError();
      const decoded = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
      if (decoded.v !== 1 || !Number.isInteger(decoded.page) || decoded.page < 1 || decoded.page >= 40
          || !decoded.cursors || typeof decoded.cursors !== 'object') throw new LearningBookNotFoundError();
      state = decoded;
    }
    const resources:{uri:string;name:string;description:string;mimeType:string}[] = [];
    const cursors:Partial<Record<LearningKind,string|null>> = {};
    for (const kind of BOOK_KINDS) {
      const previous = state.cursors[kind];
      if (previous === null) { cursors[kind] = null; continue; }
      if (previous !== undefined && typeof previous !== 'string') throw new LearningBookNotFoundError();
      const page = await fetchRecipePage(client,config,{kinds:[kind],limit:50,cursor:previous});
      for (const hit of page.items) if (hit.kind === kind && hit.adaptEligible) resources.push({
        uri:`swfte://${BOOK_PATHS[kind]}/${encodeURIComponent(hit.id)}`,name:hit.title.slice(0,120),
        description:`${kind}; backend evidence ${hit.evidenceLevel}; read current replay details before applying`,mimeType:'application/json',
      });
      cursors[kind] = page.nextCursor ?? null;
    }
    const more = Object.values(cursors).some(value => typeof value === 'string');
    return {resources,...(more ? {nextCursor:Buffer.from(JSON.stringify({v:1,page:state.page+1,cursors})).toString('base64url')} : {})};
  } catch (error) {
    if (error instanceof LearningBookNotFoundError || error instanceof SyntaxError) throw new ResourceNotFoundError('Not found');
    throw error;
  }
}

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
  const learningUri = /^swfte:\/\/(recipes|fragments|playbooks)\/([^/]+)$/.exec(uri);
  if (learningUri) {
    try {
      const kind = BOOK_KINDS.find(k => BOOK_PATHS[k] === learningUri[1])!;
      const entry = await fetchRecipe(await ctx.client(),ctx.config,decodeURIComponent(learningUri[2]!),kind);
      return {uri,mimeType:'application/json',text:JSON.stringify({dataOnly:true,entry},null,2)};
    } catch { throw new ResourceNotFoundError('Not found'); }
  }
  const ref = catalogRefFromUri(uri);
  if (!ref) throw new ResourceNotFoundError(`Unknown resource ${uri}. Known: ${CAPABILITIES_URI}, ${CATALOG_TEMPLATE}.`);
  const refKind = ref.slice(0,ref.indexOf(':')) as LearningKind;
  if (BOOK_KINDS.includes(refKind)) {
    try {
      const entry = await fetchRecipe(await ctx.client(),ctx.config,ref.slice(ref.indexOf(':')+1),refKind);
      return {uri,mimeType:'application/json',text:JSON.stringify({dataOnly:true,entry},null,2)};
    } catch { throw new ResourceNotFoundError('Not found'); }
  }
  const parsed = parseCatalogRef(ref);
  const pkg = await getContextPackage(await ctx.client(), parsed);
  return { uri, mimeType: 'application/json', text: JSON.stringify(pkg, null, 2) };
}
