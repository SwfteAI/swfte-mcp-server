import { z } from 'zod';
import { assertLocalFilesystem, confineDirectory } from '../fsguard.js';
import { scanRepository } from '../codemap/scan.js';
import { codeImpact } from '../codemap/impact.js';
import type { ToolDefinition } from './_types.js';

const repoId = z.string().regex(/^r_[0-9a-f]{32}$/);
const artifactRef = z.string().regex(/^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9_.@:-]{1,128}$/);
const revision = z.string().regex(/^[A-Za-z0-9_.:@+-]{1,128}$/);

export const codeMapTools: ToolDefinition[] = [
  { name: 'swfte_code_map', description: 'Scan local Swfte call sites into private metadata. Source and env values never upload. Consent is explicit; hosted callers cannot scan server files.',
    inputSchema: z.object({ directory: z.string().default('.'), optIn: z.boolean().optional(), hashPaths: z.boolean().optional(), attribution: z.boolean().optional(),
      tag: z.boolean().optional(), offline: z.boolean().optional(), pr: z.number().int().min(1).max(1e9).optional() }).strict(),
    execute: async (input, ctx) => {
      assertLocalFilesystem(ctx.localFilesystem, 'swfte_code_map');
      const root = confineDirectory(input.directory);
      return scanRepository(root, input.offline ? null : ctx.config, { ...input, scanner: 'mcp' });
    } },
  { name: 'swfte_code_impact', readOnly: true, description: 'Read contract impact from the authenticated code map. Unknown maps never mean zero would break; runtime pins remain separate.',
    inputSchema: z.object({ artifactRef, from: revision, to: revision }).strict(),
    execute: async (input, ctx) => codeImpact(ctx.client, input) },
  { name: 'swfte_code_fix', description: 'Prepare a content-bound call-site fix proposal in the existing action rail. Requires measured code impact; no source is uploaded and no PR or activation runs here.',
    inputSchema: z.object({ repoId, callSiteId: z.string().regex(/^cs_[0-9a-f]{24}$/), artifactRef, from: revision, to: revision,
      strategy: z.enum(['upgrade', 'keep-version']) }).strict(),
    execute: async (input, ctx) => ctx.client.request({ method: 'POST', path: '/v2/codemap/fix-proposals', body: input, retries: 0 }) },
];
