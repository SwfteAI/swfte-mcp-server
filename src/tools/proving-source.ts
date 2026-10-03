import { z } from 'zod';
import type { ToolDefinition } from './_types.js';
import type { ProofLearningBoundary, SourceIntake } from '../prove/types.js';
import { runSourceProof } from '../prove/source.js';
import { treeKey } from '../prove/treekey.js';
import { readVerdict } from '../prove/verdict.js';

export const ProvingSourceInput = z.object({
  source: z.object({ path: z.string().min(1), level: z.enum(['local', 'manifest', 'diff', 'tree']).optional() }).strict(),
  requested_checks: z.array(z.enum(['build', 'test', 'scan', 'data', 'traffic', 'attack', 'deps'])).min(1).max(7).optional(),
}).strict();

/** Merge this handler into 07's swfte_prove source variant; do not replace the existing artifact variant. */
export function sourceProofHandler(ports: { intake?: SourceIntake; learning?: ProofLearningBoundary } = {}): ToolDefinition<typeof ProvingSourceInput>['execute'] {
  return async (input, context) => {
    if (context.localFilesystem === false) return { error: true, code: 'LOCAL_FILESYSTEM_REQUIRED', message: 'Source proofs require the developer’s local filesystem' };
    return runSourceProof(context.client, { path: input.source.path, level: input.source.level,
      requestedChecks: input.requested_checks, trigger: 'mcp' }, ports);
  };
}

export const provingVerdictTools: ToolDefinition[] = [{
  name: 'swfte_prove_verdict', title: 'Read checks for the current tree', group: 'extras', readOnly: true,
  description: 'Read the server result for a local tree hash and verify its existing signed evidence record. Local positive files cannot satisfy the gate.',
  inputSchema: z.object({ path: z.string().min(1), level: z.enum(['local', 'manifest', 'diff', 'tree']).default('diff') }).strict(),
  execute: async (input, context) => {
    if (context.localFilesystem === false) return { error: true, code: 'LOCAL_FILESYSTEM_REQUIRED' };
    const snapshot = await treeKey(input.path);
    return readVerdict(context.client, snapshot.run_key, input.level);
  },
}];
