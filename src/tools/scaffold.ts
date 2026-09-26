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
import { CatalogRefArg, contractHash, getContract, getEntry, parseCatalogRef } from '../catalog.js';
import { agentEmbedHtml, EMBED_KEY_PATTERN, issueEmbedKey, publicAgentChatPath } from '../embed.js';
import { bakeArtifact, syncProject, verifyProject } from '../bake.js';
import { assertLocalFilesystem, ConfinedWriter, INLINE_NOTE } from '../fsguard.js';
import { scanInline, scanProject, unavailableScan } from '../compliance.js';
import { FRAMEWORKS } from '../stack.js';
import { emitTelemetry } from '../telemetry.js';
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
      pin: z.boolean().optional().describe('Workflows: pin the current published version (default true) so the client calls /v2/workflows/{id}/versions/{version}/invoke and upstream publishes never change it until `swfte upgrade`. false: follow every publish.'),
      complianceScan: z.boolean().optional().describe('Scan the written code with POST /v2/compliance/scan (advisory). Default true.'),
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
        pin: input.pin,
      });
      // Counts only: this codebase is now bound to the hosted artifact. No path, framework or code.
      emitTelemetry({ client, config }, { event: 'scaffold', catalogRef: r.ref });
      // Scan what was just written (code only), like `swfte add`. Advisory: a
      // finding or a scan that could not run never undoes the write.
      const code = res.files.filter((f) => f.action !== 'unchanged' && f.path !== 'swfte.json' && !/(^|\/)\.env[^/]*$/.test(f.path));
      let complianceScan = null;
      if (input.complianceScan !== false && code.length) {
        try {
          complianceScan = writer.inline
            ? await scanInline(client, code.map((f) => ({ path: f.path, content: f.content ?? '' })))
            : await scanProject(client, writer.root, code.map((f) => f.path));
        } catch (err) {
          complianceScan = unavailableScan(err instanceof Error ? err.message : String(err));
        }
      }
      return {
        ...res,
        ...(writer.inline ? { inline: true, note: INLINE_NOTE } : {}),
        complianceScan,
        nextSteps: [
          'Set SWFTE_API_KEY in your real (uncommitted) env — .env.example only names it.',
          ...(res.framework === 'nextjs' || res.framework === 'express' || res.framework === 'fastapi'
            ? ['Wire authorize() in the adapter to your auth: it answers 401 to everyone until you do (anyone who can reach the route would spend your credits).']
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
      'Return embed HTML for an artifact and optionally write it to targetFile inside the working directory (never ' +
      'overwriting an existing file unless force:true). Widgets: the markup published in the contract. Agents: a ' +
      'self-contained chat box calling the PUBLIC agent chat POST /v1/public/agents/{id}/chat with a publishable ' +
      'embed key (swfte_pk_, this agent only, origin allow-listed) — pass embedKey, or allowedOrigins to have one ' +
      'issued (POST /v2/agents/{id}/embed-keys, agent owner only). A workspace API key or PAT never goes into a page; ' +
      'secret-shaped markup is refused. Other kinds are not embeddable — use swfte_scaffold_client.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      targetFile: z.string().optional().describe('File to write the snippet to, relative to the project root (e.g. "public/support.html").'),
      force: z.boolean().optional(),
      embedKey: z.string().optional().describe('Agents: an existing publishable embed key (swfte_pk_…) for this agent.'),
      allowedOrigins: z
        .array(z.string())
        .max(20)
        .optional()
        .describe('Agents without embedKey: issue a new embed key limited to these exact origins (e.g. ["https://www.example.com"]).'),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const writer = new ConfinedWriter({ forbidden: [config.credential], inline: localFilesystem === false });
      const target = input.targetFile ? writer.resolve(input.targetFile) : null;
      const r = parseCatalogRef(input.catalogRef);
      const write = (content: string, extra: Record<string, unknown>) => {
        writer.assertNoSecrets('embed markup', content);
        if (!target) return { catalogRef: r.ref, embeddable: true, html: content, written: [], ...extra };
        writer.create(target, content, input.force);
        return { catalogRef: r.ref, embeddable: true, html: content, written: writer.commit(), ...extra };
      };

      if (r.kind === 'agent') {
        if (input.embedKey !== undefined && !EMBED_KEY_PATTERN.test(input.embedKey)) {
          // Never echo what was passed: it may be a secret key pasted by mistake.
          throw new Error('embedKey must be a publishable swfte_pk_ key. A workspace API key or PAT must never be put in a web page.');
        }
        let key = input.embedKey ?? null;
        let issued: { keyPrefix: string | null; allowedOrigins: string[] } | null = null;
        if (!key) {
          if (!input.allowedOrigins?.length) {
            return {
              catalogRef: r.ref,
              embeddable: true,
              needsEmbedKey: true,
              endpoint: publicAgentChatPath(r.id),
              message:
                'Agents embed through the public chat with a publishable key. Pass allowedOrigins (the exact site origins, ' +
                'e.g. ["https://www.example.com"]) to issue one, or embedKey if you already have one (Studio → agent → Embed).',
            };
          }
          const k = await issueEmbedKey(client, r.id, input.allowedOrigins);
          key = k.key;
          issued = { keyPrefix: k.keyPrefix, allowedOrigins: k.allowedOrigins };
        }
        const entry = await getEntry(client, r).catch(() => null);
        const html = agentEmbedHtml({ agentId: r.id, name: entry?.name || r.id, baseUrl: config.baseUrl, embedKey: key, catalogRef: r.ref });
        return write(html, {
          endpoint: publicAgentChatPath(r.id),
          ...(issued ? { issuedKey: issued, note: 'A new embed key was issued; it is shown only in this markup. Revoke it in Studio (agent → Embed) if unused.' } : {}),
        });
      }

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
      return write(`<!-- Swfte embed: ${r.ref.replace(/--/g, '-')} (contract ${contractHash(contract)}) -->\n${html.trim()}\n`, {});
    },
  },
];
