import type { DetectContext, DetectResult, DetectedSite, Detector, Implementation, SourceFile } from '../../types.js';
import { detectManaged, type PySite } from './managed.js';
import { envNameOf, grammarGeneration, isForeignGenerated, isIgnoredPath, swfteImports, usesMocks, walk, withTree } from './parse.js';
import { detectRawHttp } from './rawHttp.js';
import { detectWidgets } from './widget.js';

interface Analysis {
  sites: PySite[];
  implementations: Implementation[];
  envVarNames: string[];
}

const EMPTY: Analysis = { sites: [], implementations: [], envVarNames: [] };
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
        const managed = detectManaged(root, file.relPath, ctx, imp.swfte && !imp.fork);
        // A file the lock lists is the generated client itself: nothing in it is a call site.
        const isClient = ctx.locks.some((l) => l.files.includes(file.relPath));
        const sites = isClient ? [] : [...managed.sites, ...detectRawHttp(root), ...detectWidgets(root)];
        const names = new Set<string>();
        walk(root, (n) => {
          if (n.type === 'subscript' || n.type === 'call') {
            const nm = envNameOf(n);
            if (nm && nm.startsWith('SWFTE_')) names.add(nm);
          }
          return undefined;
        });
        return { sites, implementations: managed.implementations, envVarNames: [...names].sort() };
      }) ?? EMPTY;
  }
  last = { relPath: file.relPath, text: file.text, ctx, generation: grammarGeneration, result };
  return result;
}

const toSite = (s: PySite, relPath: string, detector: string): DetectedSite => {
  const { source: _source, ...rest } = s;
  return { ...rest, relPath, detector };
};

function pick(id: string, want: (s: PySite) => boolean, extras: boolean): Detector {
  return {
    id,
    languages: ['python'],
    detect(file, ctx): DetectResult {
      const a = analyze(file, ctx);
      return {
        sites: a.sites.filter(want).map((s) => toSite(s, file.relPath, id)),
        implementations: extras ? a.implementations : [],
        envVarNames: extras ? a.envVarNames : [],
      };
    },
  };
}

/** Python detectors (docs/codemap/CONTRACT.md §7). Ids are `<lang>.<category>`. */
export const DETECTORS: Detector[] = [
  pick('py.managed', (s) => s.category === 'managed' && s.source === 'managed', true),
  pick('py.raw-http', (s) => s.category === 'raw-http', false),
  pick('py.widget', (s) => s.category === 'widget', false),
  pick('py.dynamic', (s) => s.category === 'dynamic', false),
];
