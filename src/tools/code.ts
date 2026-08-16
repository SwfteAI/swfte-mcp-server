import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { unzipSync, zipSync } from 'fflate';
import type { ToolDefinition } from './_types.js';

const EXEC = '/v2/workflows/execution';

/**
 * Files that are generated on every emit and carry no user intent. Excluded
 * from the "what changed" summary so a real edit isn't buried under churn.
 */
const GENERATED_NOISE = /^(\.swfte\/|swfte-blueprint\.json$|docker-compose\.yml$)/;

/** Guard against a zip entry escaping the destination directory (zip-slip). */
function safeJoin(root: string, entry: string): string {
  const target = resolve(root, entry);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to write outside the destination: ${entry}`);
  }
  return target;
}

function walk(dir: string, root = dir, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // Never ship build output or VCS metadata back to the server.
    if (name === 'target' || name === '.git' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, acc);
    else acc.push(relative(root, full));
  }
  return acc;
}

/**
 * Pull the `// blueprint-*:` headers and preserved-region markers out of a
 * generated step file. Marker shapes come from `RustWriter`:
 *   // blueprint-step-id: fetch_polymarket
 *   // blueprint-step-type: FETCH_HTTP
 *   // @user:<regionId>:start   …your code…   // @user:<regionId>:end
 * Edits made OUTSIDE a user region are overwritten on the next emit.
 */
function stepHeader(src: string): { stepId?: string; stepType?: string; userRegions: string[] } {
  const stepId = /\/\/\s*blueprint-step-id:\s*([A-Za-z0-9_-]+)/.exec(src)?.[1];
  const stepType = /\/\/\s*blueprint-step-type:\s*([A-Z_]+)/.exec(src)?.[1];
  const userRegions = [...src.matchAll(/\/\/\s*@user:([A-Za-z0-9_-]+):start/g)].map((m) => m[1]!);
  return { stepId, stepType, userRegions };
}

export const codeTools: ToolDefinition[] = [
  {
    name: 'swfte_export_src',
    title: 'Download the generated code workspace',
    group: 'workflows',
    description:
      'Download an execution workflow as a real, editable Cargo workspace and unzip it locally: ' +
      'Cargo.toml, build.rs, src/graph.rs, src/steps/*.rs, swfte-blueprint.json, docker-compose.yml. ' +
      'Each step file carries blueprint-step-id / blueprint-step-type headers and marked user regions ' +
      'that survive re-emit — edit inside those, then push back with swfte_sync_src. Returns the file ' +
      'tree plus the per-step headers so you know what you are looking at without reading every file.',
    inputSchema: z.object({
      workflowId: z.string(),
      destDir: z.string().describe('Local directory to unzip into. Created if missing.'),
      overwrite: z
        .boolean()
        .optional()
        .describe('Delete destDir first. Off by default so local edits are not silently destroyed.'),
    }),
    execute: async (input, { client }) => {
      const { bytes, headers } = await client.getBinary(
        `${EXEC}/${encodeURIComponent(input.workflowId)}/download-src`,
        { timeoutMs: 180_000 }
      );

      const dest = resolve(input.destDir);
      if (input.overwrite) rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });

      const files = unzipSync(bytes);
      const written: string[] = [];
      const steps: Array<{ file: string; stepId?: string; stepType?: string; userRegions: string[] }> = [];

      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith('/')) continue;
        const target = safeJoin(dest, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
        written.push(name);

        if (name.startsWith('src/steps/') && name.endsWith('.rs') && !name.endsWith('mod.rs')) {
          const parsed = stepHeader(Buffer.from(data).toString('utf8'));
          if (parsed.stepId) steps.push({ file: name, ...parsed });
        }
      }

      return {
        workflowId: input.workflowId,
        destDir: dest,
        // Echoed so a later sync can tell "my edits" apart from "the blueprint
        // moved under me" — the two look identical in a diff otherwise.
        blueprintSha: headers['x-swfte-blueprint-sha'] || null,
        emitterVersion: headers['x-swfte-emitter-version'] || null,
        fileCount: written.length,
        files: written.sort(),
        steps,
        nextStep:
          'Edit inside the marked user regions, then swfte_sync_src to push back. It dry-runs first ' +
          'and shows the BlueprintDiff before applying.',
      };
    },
  },

  {
    name: 'swfte_sync_src',
    title: 'Push a local code workspace back',
    group: 'workflows',
    description:
      'Zip a local workspace directory and push it back to the workflow. DRY-RUNS BY DEFAULT: returns ' +
      'the BlueprintDiff (added / removed / modified steps, renames, unreconcilable changes) without ' +
      'writing anything. Pass apply:true to commit. Round-tripping an UNMODIFIED workspace should ' +
      'report hasChanges:false — if it does not, the emitter and the reverse parser have drifted, ' +
      'which is worth investigating before trusting any diff.',
    inputSchema: z.object({
      workflowId: z.string(),
      srcDir: z.string().describe('The workspace directory previously produced by swfte_export_src.'),
      apply: z.boolean().optional().describe('Actually commit the change. Default false (dry run).'),
    }),
    execute: async (input, { client }) => {
      const root = resolve(input.srcDir);
      const names = walk(root);
      if (names.length === 0) throw new Error(`No files found under ${root}`);

      const entries: Record<string, Uint8Array> = {};
      for (const name of names) {
        // Zip entries must use forward slashes regardless of host platform.
        entries[name.split(sep).join('/')] = new Uint8Array(readFileSync(join(root, name)));
      }
      const zipped = zipSync(entries);

      // Slice out a real ArrayBuffer rather than casting the view — fflate may
      // return a Uint8Array over a larger pooled buffer, and handing Blob the
      // whole buffer would upload trailing garbage.
      const buf = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);

      const form = new FormData();
      form.append('workspace', new Blob([buf], { type: 'application/zip' }), 'workspace.zip');

      const res = await client.postMultipart<any>(
        `${EXEC}/${encodeURIComponent(input.workflowId)}/sync-from-code`,
        form,
        { query: { dryRun: !input.apply }, timeoutMs: 180_000 }
      );

      const meaningful = (res?.modifiedSteps ?? []).filter(
        (s: unknown) => !GENERATED_NOISE.test(String(s))
      );

      return {
        applied: Boolean(input.apply),
        dryRun: !input.apply,
        workflowId: input.workflowId,
        filesUploaded: names.length,
        hasChanges: res?.hasChanges ?? false,
        outcome: res?.outcome,
        addedStepIds: res?.addedStepIds ?? [],
        removedStepIds: res?.removedStepIds ?? [],
        modifiedSteps: res?.modifiedSteps ?? [],
        renames: res?.renames ?? [],
        // Changes the reverse parser could not map back onto the blueprint.
        // These are the ones that will be silently lost if you apply.
        unreconcilable: res?.unreconcilable ?? [],
        newVersion: res?.newVersion,
        blueprintSha: res?.blueprintSha,
        ...(res?.unreconcilable?.length
          ? {
              warning:
                `${res.unreconcilable.length} change(s) could not be reconciled onto the blueprint and ` +
                'will NOT be applied. Move that logic inside a marked user region, or express it as a step.',
            }
          : {}),
        ...(!input.apply
          ? {
              nextStep: meaningful.length
                ? 'Re-call with apply:true to commit these changes.'
                : 'No meaningful step changes detected.',
            }
          : {}),
      };
    },
  },
];
