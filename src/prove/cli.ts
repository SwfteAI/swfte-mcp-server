import { resolve } from 'node:path';
import type { ProofLearningBoundary, ProofLevel, SourceIntake } from './types.js';
import { PROOF_LEVELS } from './types.js';
import { treeKey } from './treekey.js';
import { readVerdict, verdictLine, type ProvingClient } from './verdict.js';
import { installProvingGate } from './gate.js';
import { runSourceProof } from './source.js';
import { readCollectorActivity, watchProof } from './watch.js';

export interface ProveCliContext {
  cwd: string; client?: ProvingClient; intake?: SourceIntake; learning?: ProofLearningBoundary;
  output(line: string): void; signal?: AbortSignal;
}
/** Coordinator calls this from the shared CLI dispatcher; no module installs hooks or auto-starts. */
export async function handleProveCommand(args: string[], context: ProveCliContext): Promise<number> {
  const values = [...args];
  const subcommand = ['verdict', 'init-gate', 'watch'].includes(values[0] ?? '') ? values.shift()! : 'source';
  let path = context.cwd; let level: ProofLevel | undefined; let sessionId: string | undefined; let watch = false;
  while (values.length) {
    const value = values.shift()!;
    if (value === '--level') {
      const next = values.shift();
      if (!PROOF_LEVELS.includes(next as ProofLevel)) throw new Error('Expected local, manifest, diff or tree');
      level = next as ProofLevel;
    } else if (value === '--tree') {
      if (values.shift() !== 'HEAD+worktree') throw new Error('Only HEAD+worktree is supported');
    } else if (value === '--session') { sessionId = values.shift(); }
    else if (value === '--watch') { watch = true; }
    else if (value.startsWith('-')) throw new Error('Unknown prove option');
    else path = resolve(context.cwd, value);
  }
  if (subcommand === 'verdict') {
    try {
      const snapshot = await treeKey(path);
      const result = await readVerdict(context.client, snapshot.run_key, level ?? 'diff');
      context.output(verdictLine(result)); return result.exitCode;
    } catch { context.output('PROOF_UNPROVEN unproven: current tree could not be read'); return 1; }
  }
  if (subcommand === 'init-gate') {
    const result = await installProvingGate(path);
    context.output(`PG gate installed: ${result.path}. Nexus gate mode is unchanged; approve its oracle with nexus gates check --approve.`);
    if (!watch) return 0;
  }
  if (subcommand === 'watch' || watch) {
    if (!sessionId || !context.client || !context.intake || !context.learning?.proofOriginExcludedByDefault()) {
      context.output('unproven: watch requires a session, sign-in and the shared consent and private-learning adapters'); return 0;
    }
    if (!context.signal) throw new Error('Proof watch requires a caller-controlled abort signal');
    await watchProof({ path, sessionId, level: level ?? 'diff', signal: context.signal }, {
      activity: id => readCollectorActivity(id), snapshot: treeKey, output: context.output,
      prove: async (snapshot, resolvedLevel, session) => {
        const result = await runSourceProof(context.client, { path: snapshot.root, level: resolvedLevel, sessionId: session,
          trigger: 'verified_edit' }, { intake: context.intake, learning: context.learning });
        context.output(`swfte · ${result.verdict} · tree ${result.run_key.slice(0, 12)}${'report_url' in result && result.report_url ? ` · report: ${result.report_url}` : ''}`);
      },
    });
    return 0;
  }
  try {
    const result = await runSourceProof(context.client, { path, level, trigger: 'cli' }, { intake: context.intake, learning: context.learning });
    if (!('token' in result) && result.verdict === 'PASS') {
      const verified = await readVerdict(context.client, result.run_key, result.level);
      context.output(verdictLine(verified)); return verified.exitCode;
    }
    context.output('token' in result ? result.token + (result.dependency_gaps.length ? ` unproven: ${result.dependency_gaps.join(', ')}` : '')
      : `swfte · ${result.verdict} · tree ${result.run_key.slice(0, 12)}`);
    return 1;
  } catch { context.output('PROOF_UNPROVEN unproven: source, consent or proving dependency unavailable'); return 1; }
}
