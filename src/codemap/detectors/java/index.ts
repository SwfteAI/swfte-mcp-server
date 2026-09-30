import type { DetectContext, DetectResult, DetectedSite, Detector, SourceFile } from '../../types.js';
import { detectManaged, type JavaSite } from './managed.js';
import { envNameOf, grammarGeneration, isForeignGenerated, isIgnoredPath, swfteImports, usesMocks, valueAnnotationEnv, walk, withTree } from './parse.js';
import { detectRawHttp } from './rawHttp.js';
import { detectWidgets } from './widget.js';

interface Analysis {
  sites: JavaSite[];
  envVarNames: string[];
}

const EMPTY: Analysis = { sites: [], envVarNames: [] };
let last: { relPath: string; text: string; ctx: DetectContext; generation: number; result: Analysis } | null = null;

/** One parse per file, shared by the four detectors (they run back to back on the same file). */
function analyze(file: SourceFile, ctx: DetectContext): Analysis {
  if (last && last.relPath === file.relPath && last.text === file.text && last.ctx === ctx && last.generation === grammarGeneration) return last.result;
  let result: Analysis = EMPTY;
  if (!isIgnoredPath(file.relPath) && !isForeignGenerated(file.text)) {
    result =
      withTree(file.text, (root): Analysis => {
        if (usesMocks(root)) return EMPTY;
        const imp = swfteImports(root);
        const sites = [...detectManaged(root, imp.swfte && !imp.fork), ...detectRawHttp(root), ...detectWidgets(root)];
        const names = new Set<string>();
        walk(root, (n) => {
          const nm = n.type === 'method_invocation' ? envNameOf(n) : n.type === 'annotation' ? valueAnnotationEnv([n]) : null;
          if (nm && nm.startsWith('SWFTE_')) names.add(nm);
          return undefined;
        });
        return { sites, envVarNames: [...names].sort() };
      }) ?? EMPTY;
  }
  last = { relPath: file.relPath, text: file.text, ctx, generation: grammarGeneration, result };
  return result;
}

const toSite = (s: JavaSite, relPath: string, detector: string): DetectedSite => {
  const { source: _source, ...rest } = s;
  return { ...rest, relPath, detector };
};

function pick(id: string, want: (s: JavaSite) => boolean, extras: boolean): Detector {
  return {
    id,
    languages: ['java'],
    detect(file, ctx): DetectResult {
      const a = analyze(file, ctx);
      return {
        sites: a.sites.filter(want).map((s) => toSite(s, file.relPath, id)),
        implementations: [],
        envVarNames: extras ? a.envVarNames : [],
      };
    },
  };
}

/** Java detectors (docs/codemap/CONTRACT.md §7). Ids are `<lang>.<category>`. */
export const DETECTORS: Detector[] = [
  pick('java.managed', (s) => s.source === 'managed' && s.category === 'managed', true),
  pick('java.raw-http', (s) => s.category === 'raw-http', false),
  pick('java.widget', (s) => s.category === 'widget', false),
  pick('java.dynamic', (s) => s.category === 'dynamic', false),
];
