/**
 * Code-bridge tools: bake a catalog artifact into the developer's codebase.
 *
 * `swfte_scaffold_client` turns an artifact's published contract into a typed,
 * dependency-free client file, an `.env.example` naming the variables it reads,
 * and an entry in `swfte.json` — a lock recording which catalog entry and which
 * contract version the code was generated against, so drift is detectable.
 * `swfte_embed_widget` does the same for an embeddable surface.
 *
 * All writes go through ConfinedWriter: confined under the working directory,
 * no overwrite without `force`, no secret on disk.
 */
import { z } from 'zod';
import { CatalogRefArg, contractHash, getContract, getEntry, parseCatalogRef, type CatalogContract } from '../catalog.js';
import { kebab, renderPythonClient, renderTypeScriptClient, snake } from '../codegen.js';
import { ConfinedWriter, INLINE_NOTE } from '../fsguard.js';
import type { ToolDefinition } from './_types.js';

export const LOCK_FILE = 'swfte.json';

export const CLIENT_ENV = [
  { key: 'SWFTE_API_KEY', value: '', comment: 'Swfte PAT (pat_…) or workspace API key (sk-swfte-…). Server-side only; never commit a real value.' },
  { key: 'SWFTE_BASE_URL', value: '', comment: 'Optional. Defaults to the Swfte cloud API.' },
  { key: 'SWFTE_WORKSPACE_ID', value: '', comment: 'Optional with a PAT (the token carries its workspace); used with API keys.' },
];

export interface LockEntry {
  catalogRef: string;
  kind: string;
  id: string;
  name?: string;
  updatedAt?: string | null;
  shapeHash?: string | null;
  contractHash: string;
  languages?: string[];
  files: string[];
  scaffoldedAt: string;
  [k: string]: unknown;
}

/** Keyed upsert of one artifact into the lock document, preserving anything else the developer keeps there. */
export function upsertLock(
  current: Record<string, unknown>,
  entry: Omit<LockEntry, 'files' | 'languages'> & { files: string[]; language?: string }
): { doc: Record<string, unknown>; previousHash: string | null } {
  const artifacts = Array.isArray(current.artifacts) ? [...(current.artifacts as LockEntry[])] : [];
  const i = artifacts.findIndex((a) => a && a.catalogRef === entry.catalogRef);
  const prev = i >= 0 ? artifacts[i]! : null;
  const { language, ...rest } = entry;
  const merged = {
    ...(prev ?? {}),
    ...rest,
    languages: [...new Set([...(prev?.languages ?? []), ...(language ? [language] : [])])].sort(),
    files: [...new Set([...(prev?.files ?? []), ...entry.files])].sort(),
  } as LockEntry;
  if (i >= 0) artifacts[i] = merged;
  else artifacts.push(merged);
  artifacts.sort((a, b) => String(a.catalogRef).localeCompare(String(b.catalogRef)));
  return {
    doc: { version: 1, source: 'swfte-studio', ...current, artifacts },
    previousHash: prev?.contractHash ?? null,
  };
}

export const scaffoldTools: ToolDefinition[] = [
  {
    name: 'swfte_scaffold_client',
    title: 'Bake a catalog artifact into the codebase',
    description:
      'Write a typed client for a catalog artifact into the local project: TypeScript (fetch, no deps) or ' +
      'Python (stdlib only), with Input/Output types generated from the contract\'s JSON Schemas and an ' +
      'invoke/chat function that polls async runs to completion. Also merges SWFTE_API_KEY / SWFTE_BASE_URL / ' +
      'SWFTE_WORKSPACE_ID into .env.example and records {catalogRef, updatedAt, contractHash} in swfte.json. ' +
      'targetDir must be inside the working directory; existing files are never overwritten unless force:true ' +
      '(nothing is written if any would be). No credential is ever written. Use after swfte_get_context.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      language: z.enum(['typescript', 'python']),
      targetDir: z.string().min(1).describe('Directory relative to the project root (e.g. "src/swfte"). Created if missing.'),
      force: z.boolean().optional().describe('Replace an existing client file whose content differs. Default false.'),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const writer = new ConfinedWriter({ forbidden: [config.credential], inline: localFilesystem === false });
      // Confine before any network call: a bad path should fail fast and free.
      const dir = writer.resolve(input.targetDir);
      const r = parseCatalogRef(input.catalogRef);
      const [detail, contract] = await Promise.all([getEntry(client, r), getContract(client, r)]);
      if (!contract?.invoke?.path) {
        throw new Error(`${r.ref} has no invocation contract, so there is nothing to generate a client for.`);
      }
      const hash = contractHash(contract);
      const name = detail.name || `${r.kind} ${r.id}`;
      const spec = {
        catalogRef: r.ref,
        kind: r.kind,
        id: detail.id ?? r.id,
        name,
        description: detail.description ?? null,
        contract: contract as CatalogContract,
        contractHash: hash,
        defaultBaseUrl: config.baseUrl,
      };
      const clientFile =
        input.language === 'typescript'
          ? { name: `${kebab(name, r.kind)}.ts`, content: renderTypeScriptClient(spec) }
          : { name: `${snake(name, r.kind)}.py`, content: renderPythonClient(spec) };

      const clientAbs = writer.resolve(`${dir}/${clientFile.name}`);
      writer.create(clientAbs, clientFile.content, input.force);
      const envResult = writer.mergeEnv(writer.resolve(`${dir}/.env.example`), CLIENT_ENV, {
        header: 'Swfte — read by generated clients (swfte_scaffold_client)',
      });
      let previousHash: string | null = null;
      writer.mergeJson(writer.resolve(`${dir}/${LOCK_FILE}`), (current) => {
        const res = upsertLock(current, {
          catalogRef: r.ref,
          kind: r.kind,
          id: spec.id,
          name,
          updatedAt: detail.updatedAt ?? null,
          shapeHash: detail.shapeHash ?? null,
          contractHash: hash,
          language: input.language,
          files: [writer.rel(clientAbs)],
          scaffoldedAt: new Date().toISOString(),
        });
        previousHash = res.previousHash;
        return res.doc;
      });
      const written = writer.commit();
      const drift = previousHash && previousHash !== hash;
      return {
        catalogRef: r.ref,
        language: input.language,
        files: written,
        ...(writer.inline ? { inline: true, note: INLINE_NOTE } : {}),
        env: envResult,
        contractHash: hash,
        ...(drift ? { contractChanged: { from: previousHash, to: hash, note: 'The contract moved since the last scaffold; review call sites against the regenerated types.' } } : {}),
        evidenceLevel: detail.evidence?.level ?? 'unmeasured',
        usage:
          input.language === 'typescript'
            ? `import { ${clientFile.content.match(/export async function (\w+)/)?.[1]} } from './${clientFile.name.replace(/\.ts$/, '')}';`
            : `from ${clientFile.name.replace(/\.py$/, '')} import ${clientFile.content.match(/^def (\w+)\(/m)?.[1]}`,
        nextSteps: [
          'Set SWFTE_API_KEY in your real (uncommitted) env — .env.example only names it.',
          'Mint an API key scoped to this artifact in Studio if the code only needs to call it.',
          ...(r.kind === 'application' ? ['Wire analytics / payments: swfte_wire_analytics, swfte_wire_payments.'] : []),
          ...(r.kind === 'workflow' ? ['Published workflows run via /invoke; publish a version first if the call returns PUBLISHED_SNAPSHOT_UNAVAILABLE.'] : []),
        ],
      };
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
