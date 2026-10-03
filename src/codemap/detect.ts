/**
 * Detector dispatch (docs/codemap/CONTRACT.md §7): walk the scan root, hand each source file with its
 * DetectContext to every detector that speaks its language, and gather the results in a deterministic
 * order. File text stays in this process; only DetectedSite fields ever reach the manifest, and the
 * manifest serializer (manifest.ts) is the allowlist that decides that.
 */
import { DETECTORS } from './detectors/index.js';
import { releaseParsedSource } from './detectors/ts/parse.js';
import { releaseAnalysis as releaseTypeScriptAnalysis } from './detectors/ts/index.js';
import { releaseAnalysis as releasePythonAnalysis } from './detectors/py/index.js';
import { releaseAnalysis as releaseJavaAnalysis } from './detectors/java/index.js';
import { cmp } from './fingerprint.js';
import { NativeScanReader, withNativeScanReader } from './native-reader.js';
import type { DetectedSite, Detector, Implementation, SourceFile } from './types.js';
import {
  contextOf,
  DEFAULT_ENV_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_SKIP_DIRS,
  packageOf,
  readNativeSource,
  walkProjectWithReader,
  type EnvFileRules,
} from './walk.js';

export interface DetectOptions {
  detectors?: Detector[];
  skipDirs?: string[];
  skipGenerated?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  preprocess?: (f: SourceFile) => SourceFile;
  /** Env-file basename globs (CONTRACT D10); defaults to walk.ts DEFAULT_ENV_FILES. */
  envFiles?: EnvFileRules;
}

export interface DetectOutcome {
  sites: DetectedSite[];
  implementations: Implementation[];
  envVarNames: string[];
  notAnalysed: Record<string, number>;
  truncated: boolean;
  filesScanned: number;
  packages: Map<string, { pkgId: string; pkgRelPath: string }> /* keyed by relPath */;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function releaseSourceCaches(): void {
  releaseParsedSource();
  releaseTypeScriptAnalysis();
  releasePythonAnalysis();
  releaseJavaAnalysis();
}

export async function detectProject(root: string, opts: DetectOptions = {}): Promise<DetectOutcome> {
  try { return await withNativeScanReader(root, reader => detectProjectWithReader(reader, opts)); }
  finally { releaseSourceCaches(); }
}

/** Never closes the borrowed native root, but always releases source/parser caches. */
export async function detectProjectWithReader(reader: NativeScanReader, opts: DetectOptions = {}): Promise<DetectOutcome> {
  try {
    return scanProject(reader, opts);
  } finally {
    // Empty scans and failures before the first detector are also privacy boundaries.
    releaseSourceCaches();
  }
}

function scanProject(reader: NativeScanReader, opts: DetectOptions): DetectOutcome {
  const detectors = opts.detectors ?? DETECTORS;
  const walkOpts = {
    skipDirs: opts.skipDirs ?? [...DEFAULT_SKIP_DIRS],
    skipGenerated: opts.skipGenerated ?? true,
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    envFiles: opts.envFiles ?? DEFAULT_ENV_FILES,
  };
  const walked = walkProjectWithReader(reader, walkOpts);

  const sites: Array<{ site: DetectedSite; order: number }> = [];
  const implementations: Implementation[] = [];
  const envVarNames = new Set<string>(walked.envExampleNames);
  const packages = new Map<string, { pkgId: string; pkgRelPath: string }>();
  let truncated = walked.truncated;
  let filesScanned = 0;
  let order = 0;

  for (const entry of walked.files) {
    try {
      const read = readNativeSource(reader, entry, walkOpts);
      if (!('text' in read)) {
        // A file that became unreadable or oversized after the walk leaves the map incomplete.
        if (read.skipped === 'unreadable') truncated = true;
        continue;
      }
      let file: SourceFile = { relPath: entry.relPath, language: entry.language, text: read.text };
      if (opts.preprocess) {
        const p = opts.preprocess(file);
        // A preprocessor may rewrite the text, never which file or language it is.
        file = { relPath: entry.relPath, language: entry.language, text: p.text };
      }
      const ctx = contextOf(entry.relPath, walked.locks);
      filesScanned++;
      packages.set(entry.relPath, packageOf(entry.relPath, walked.packages));
      for (const d of detectors) {
        if (!d.languages.includes(file.language)) continue;
        let res;
        try {
          res = d.detect(file, ctx);
        } catch {
          // One file a detector cannot handle must not end the scan, but the map is then incomplete.
          truncated = true;
          continue;
        }
        // A detector reports on the file it was given; relPath is pinned to it.
        for (const s of res.sites) sites.push({ site: { ...s, relPath: entry.relPath }, order: order++ });
        for (const i of res.implementations) implementations.push({ relPath: entry.relPath, line: i.line, alias: i.alias });
        for (const n of res.envVarNames) if (ENV_NAME.test(n)) envVarNames.add(n);
      }
    } finally {
      releaseSourceCaches();
    }
  }

  // Files in code-point order (the walk's), then line; detector order breaks ties (stable).
  sites.sort((a, b) => cmp(a.site.relPath, b.site.relPath) || a.site.line - b.site.line || a.order - b.order);
  implementations.sort((a, b) => cmp(a.relPath, b.relPath) || a.line - b.line || cmp(a.alias, b.alias));
  const uniqueImpls = implementations.filter(
    (x, i) => i === 0 || x.relPath !== implementations[i - 1]!.relPath || x.line !== implementations[i - 1]!.line || x.alias !== implementations[i - 1]!.alias
  );

  return {
    sites: sites.map((s) => s.site),
    implementations: uniqueImpls,
    envVarNames: [...envVarNames].sort(cmp),
    notAnalysed: { ...walked.notAnalysed },
    truncated,
    filesScanned,
    packages,
  };
}
