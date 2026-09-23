/**
 * Code-bridge tools: bake a catalog artifact into the developer's codebase and
 * keep it bound to the living artifact (CONTRACT rev 4).
 *
 * `swfte_scaffold_client` detects the project's stack, writes a typed,
 * dependency-free client plus a framework adapter (Next.js route handler,
 * Express router, FastAPI APIRouter), names the env vars in .env.example, and
 * pins the contract in swfte.json. `swfte_sync` and `swfte_check_upgrades`
 * are the MCP faces of `swfte sync` / `swfte verify` — same code (src/bake.ts).
 * `swfte_embed_widget` does the same for an embeddable surface.
 *
 * All writes go through ConfinedWriter: confined under the working directory,
 * no overwrite without `force`, no secret on disk.
 */
import { z } from 'zod';
import { CatalogRefArg, contractHash, getContract, parseCatalogRef } from '../catalog.js';
import { bakeArtifact, syncProject, verifyProject } from '../bake.js';
import { assertLocalFilesystem, ConfinedWriter, INLINE_NOTE } from '../fsguard.js';
import { FRAMEWORKS } from '../stack.js';
import type { ToolDefinition } from './_types.js';

export { LOCK_FILE } from '../lock.js';
export { CLIENT_ENV } from '../bake.js';

const LOCAL_ONLY =
  'It reads swfte.json and the generated files in the project, so it needs the server running locally (stdio) ' +
  'inside the repository. From a hosted server, run the same check in the repo instead: `npx -p @swfte/mcp-server swfte verify` / `swfte sync`.';

export const scaffoldTools: ToolDefinition[] = [
  {
    name: 'swfte_scaffold_client',
    title: 'Bake a catalog artifact into the codebase',
    description:
      'Write a typed client for a catalog artifact into the local project — TypeScript (fetch, no deps) or Python ' +
      '(stdlib only) — plus a framework adapter detected from the project (package.json next → Next.js App Router ' +
      'route app/api/<alias>/route.ts; express → Express router; pyproject/requirements fastapi → FastAPI APIRouter; ' +
      'otherwise the plain client). Generated clients send X-Swfte-Client, read agent replies as content ?? response ' +
      'and poll execution.status. Merges SWFTE_API_KEY / SWFTE_BASE_URL / SWFTE_WORKSPACE_ID into .env.example and ' +
      'pins {catalogRef, alias, framework, contractHash} in swfte.json v1 at the repo root (older locks migrate). ' +
      'Paths must stay inside the working directory; existing files are never overwritten unless force:true ' +
      '(nothing is written if any would be). No credential is ever written. Same as `swfte add`. Use after swfte_get_context.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      framework: z.enum(FRAMEWORKS).optional().describe('Override stack detection.'),
      language: z.enum(['typescript', 'python']).optional().describe('Override the language (implies the plain adapter when it disagrees with the detected framework).'),
      targetDir: z.string().min(1).optional().describe('Directory for the client, relative to the project root. Default by framework (lib/swfte, src/swfte, app/swfte, swfte).'),
      alias: z.string().optional().describe('Stable local name (lowercase, dashes). Default: the artifact name in kebab-case. Symbols and the route path derive from it.'),
      force: z.boolean().optional().describe('Replace existing files whose content differs. Default false.'),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const writer = new ConfinedWriter({ forbidden: [config.credential], inline: localFilesystem === false });
      const r = parseCatalogRef(input.catalogRef);
      const res = await bakeArtifact({ client, config, writer }, {
        catalogRef: r.ref,
        framework: input.framework,
        language: input.language,
        outDir: input.targetDir,
        alias: input.alias,
        force: input.force,
      });
      return {
        ...res,
        ...(writer.inline ? { inline: true, note: INLINE_NOTE } : {}),
        nextSteps: [
          'Set SWFTE_API_KEY in your real (uncommitted) env — .env.example only names it.',
          ...(res.framework === 'nextjs' || res.framework === 'express' || res.framework === 'fastapi'
            ? ['Add your auth check to the adapter where marked: anyone who can reach that route spends your credits.']
            : []),
          'Commit swfte.json with the generated files; add `npx -p @swfte/mcp-server swfte verify` to CI so contract drift fails the build.',
          'Mint an API key scoped to this artifact in Studio if the code only needs to call it.',
          ...(res.lock.legacySources.length ? [`Delete the old lock file(s) now folded into swfte.json: ${res.lock.legacySources.join(', ')}.`] : []),
          ...(r.kind === 'application' ? ['Wire analytics / payments: swfte_wire_analytics, swfte_wire_payments.'] : []),
          ...(r.kind === 'workflow' ? ['Published workflows run via /invoke; publish a version first if the call returns PUBLISHED_SNAPSHOT_UNAVAILABLE.'] : []),
        ],
      };
    },
  },
  {
    name: 'swfte_sync',
    title: 'Sync baked clients with their contracts',
    description:
      'For every artifact in swfte.json (or just `aliases`), refetch its contract and regenerate the typed client ' +
      'where the contract hash moved or the file is missing, then print a diff summary (+/- input and output fields). ' +
      'Breaking changes and capability changes that need re-approval are held back, never applied by a routine sync ' +
      '(use `upgrade:true` for a breaking change the developer accepted). Adapters are never rewritten; hand-edited ' +
      'clients are held back unless force. dryRun reports without writing. Same code as `swfte sync` / `swfte upgrade`.',
    inputSchema: z.object({
      aliases: z.array(z.string()).optional().describe('Only these swfte.json aliases.'),
      dryRun: z.boolean().optional(),
      upgrade: z.boolean().optional().describe('Accept breaking contract changes for the selected aliases (like `swfte upgrade`).'),
      acceptCapabilityChanges: z.boolean().optional().describe('Also accept changes flagged requiresReapproval — only after a human reviewed them.'),
      force: z.boolean().optional().describe('Replace hand-edited generated clients.'),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      assertLocalFilesystem(localFilesystem, 'swfte_sync', LOCAL_ONLY);
      const writer = new ConfinedWriter({ forbidden: [config.credential] });
      return syncProject(
        { client, config, writer },
        {
          aliases: input.aliases,
          dryRun: input.dryRun,
          allowBreaking: input.upgrade,
          acceptCapabilityChanges: input.acceptCapabilityChanges,
          force: input.force,
        }
      );
    },
  },
  {
    name: 'swfte_check_upgrades',
    title: 'Verify baked clients (drift, breaking upgrades, re-approval)',
    readOnly: true,
    description:
      'The CI gate as a tool, same code as `swfte verify`: checks swfte.json against the generated files (missing, ' +
      'hand-edited, generated against a different contract hash) and asks GET /v2/catalog/upgrades whether any pinned ' +
      'contract has a breaking change or capability changes needing re-approval. Returns ok, exitCode ' +
      '(0 in sync, 1 drift/breaking/re-approval, 2 could not check), problems with fixes, warnings (e.g. non-breaking ' +
      'upgrades available) and the upgrade items. offline:true skips the backend.',
    inputSchema: z.object({ offline: z.boolean().optional() }),
    execute: async (input, { client, config, localFilesystem }) => {
      assertLocalFilesystem(localFilesystem, 'swfte_check_upgrades', LOCAL_ONLY);
      const writer = new ConfinedWriter({ forbidden: [config.credential] });
      const report = await verifyProject({ client, config, writer }, { offline: input.offline });
      return { ...report, verdict: report.ok ? 'SWFTE_VERIFY_OK' : report.exitCode === 2 ? 'SWFTE_VERIFY_UNCHECKED' : 'SWFTE_VERIFY_FAILED' };
    },
  },
  {
    name: 'swfte_embed_widget',
    title: 'Embed a catalog artifact in a page',
    description:
      'Return the embed HTML published in an artifact\'s contract (widgets and other embeddable surfaces), and ' +
      'optionally write it to targetFile inside the working directory (never overwriting an existing file ' +
      'unless force:true). Refuses markup containing a secret-shaped credential. Artifacts without contract.embed ' +
      'are reported as not embeddable — call them through swfte_scaffold_client instead.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      targetFile: z.string().optional().describe('File to write the snippet to, relative to the project root (e.g. "public/support.html").'),
      force: z.boolean().optional(),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const writer = new ConfinedWriter({ forbidden: [config.credential], inline: localFilesystem === false });
      const target = input.targetFile ? writer.resolve(input.targetFile) : null;
      const r = parseCatalogRef(input.catalogRef);
      const contract = await getContract(client, r);
      const html = contract?.embed?.html;
      if (!html) {
        return {
          catalogRef: r.ref,
          embeddable: false,
          message: `${r.ref} publishes no embed markup. Use swfte_scaffold_client to call it from code instead.`,
        };
      }
      writer.assertNoSecrets('embed markup', html);
      const content = `<!-- Swfte embed: ${r.ref.replace(/--/g, '-')} (contract ${contractHash(contract)}) -->\n${html.trim()}\n`;
      if (!target) return { catalogRef: r.ref, embeddable: true, html: content, written: [] };
      writer.create(target, content, input.force);
      const written = writer.commit();
      return { catalogRef: r.ref, embeddable: true, html: content, written };
    },
  },
];
