import { releaseKeyAnalysis } from './keys.js';
import type { DetectContext, DetectResult, DetectedSite, Detector, SourceFile } from '../../types.js';
import { managedSites } from './managed.js';
import { rawHttpSites } from './rawHttp.js';
import { widgetSites } from './widget.js';

/**
 * TypeScript/JavaScript detectors (docs/codemap/CONTRACT.md §7). Ids are `<lang>.<category>`: a site
 * whose artifact id could be resolved comes from `ts.managed`, `ts.raw-http` or `ts.widget`; one that
 * could not (id from a variable, config or env) comes from `ts.dynamic` and is never guessed.
 */
const LANGS: Detector['languages'] = ['typescript', 'javascript'];
const resolved = (s: DetectedSite) => !s.artifact.unresolved;

type Run = (f: SourceFile, c: DetectContext) => DetectResult;

/** The four detectors of one file run back to back; each analysis runs once per file, not once per detector. */
const memo = new WeakMap<Run, { file: SourceFile; ctx: DetectContext; result: DetectResult }>();

/** The detector functions are process-lifetime keys; their source-bearing values are file-scoped. */
export function releaseAnalysis(): void {
  releaseKeyAnalysis();
  memo.delete(managedSites);
  memo.delete(rawHttpSites);
  memo.delete(widgetSites);
}

function cached(run: Run, file: SourceFile, ctx: DetectContext): DetectResult {
  const hit = memo.get(run);
  if (hit && hit.file === file && hit.ctx === ctx) return hit.result;
  const result = run(file, ctx);
  memo.set(run, { file, ctx, result });
  return result;
}

function of(id: string, run: Run): Detector {
  return {
    id,
    languages: LANGS,
    detect(file, ctx) {
      const r = cached(run, file, ctx);
      return { sites: r.sites.filter(resolved), implementations: r.implementations, envVarNames: r.envVarNames };
    },
  };
}

const dynamic: Detector = {
  id: 'ts.dynamic',
  languages: LANGS,
  detect(file, ctx) {
    const sites: DetectedSite[] = [];
    for (const run of [managedSites, rawHttpSites, widgetSites]) {
      const r = cached(run, file, ctx);
      sites.push(...r.sites.filter((s) => !resolved(s)).map((s) => ({ ...s, detector: 'ts.dynamic' })));
    }
    sites.sort((a, b) => a.line - b.line);
    return { sites, implementations: [], envVarNames: [] };
  },
};

export const DETECTORS: Detector[] = [of('ts.managed', managedSites), of('ts.raw-http', rawHttpSites), of('ts.widget', widgetSites), dynamic];
