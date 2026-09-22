/**
 * `swfte` — bake Swfte Studio artifacts into a codebase and keep them bound.
 *
 *   swfte add <catalogRef> [--framework nextjs|express|fastapi|plain-ts|plain-python] [--out <dir>] [--alias <name>] [--force]
 *   swfte sync [--alias <name>]... [--dry-run] [--force]
 *   swfte verify [--offline] [--json]          exit 0 in sync · 1 drift / breaking / re-approval · 2 could not check
 *   swfte upgrade <alias> [--accept-capability-changes] [--force] [--dry-run]
 *
 * Auth from the environment: SWFTE_API_KEY (or SWFTE_PAT), SWFTE_BASE_URL,
 * SWFTE_WORKSPACE_ID. Runs in the current directory (the repo root, where
 * swfte.json lives) or --cwd <dir>. Every command is the same code the MCP
 * tools run (src/bake.ts); this file only parses arguments and prints.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { bakeArtifact, syncProject, upgradeAlias, verifyProject, type SyncResult, type VerifyReport } from './bake.js';
import { SwfteApiError, SwfteClient } from './client.js';
import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { ConfinedWriter, OverwriteRefusedError, PathConfinementError } from './fsguard.js';
import { loadLock, LockError } from './lock.js';
import { FRAMEWORKS, type Framework } from './stack.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const USAGE = `swfte ${PACKAGE_VERSION} — bake Swfte Studio artifacts into your codebase (${PACKAGE_NAME})

Usage:
  swfte add <catalogRef> [--framework <f>] [--out <dir>] [--alias <name>] [--language typescript|python] [--force]
  swfte sync [--alias <name>]... [--dry-run] [--force]
  swfte verify [--offline] [--json]
  swfte upgrade <alias> [--accept-capability-changes] [--force] [--dry-run]

  <catalogRef>   "<kind>:<id>", e.g. workflow:wf_123 (from swfte_find_existing or Studio)
  --framework    ${FRAMEWORKS.join(' | ')} (default: detected from package.json / pyproject.toml / requirements*.txt)
  --cwd <dir>    project root holding swfte.json (default: current directory)
  --json         machine-readable output

Environment:
  SWFTE_API_KEY  workspace API key (sk-swfte-…) or PAT (pat_…); SWFTE_PAT also accepted
  SWFTE_BASE_URL API base (default https://api.swfte.com/agents, or swfte.json baseUrl)
  SWFTE_WORKSPACE_ID  workspace id (API keys)

verify exit codes: 0 in sync (prints SWFTE_VERIFY_OK) · 1 drift, breaking upgrade or re-approval pending · 2 could not check.`;

interface Parsed {
  command: string | null;
  positionals: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN = new Set(['force', 'dry-run', 'offline', 'json', 'accept-capability-changes', 'help', 'version']);
const VALUED = new Set(['framework', 'out', 'alias', 'language', 'cwd']);
const SHORT: Record<string, string> = { f: 'force', h: 'help', v: 'version', C: 'cwd' };

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const push = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const long = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    const short = /^-([a-zA-Z])$/.exec(a);
    const name = long ? long[1]! : short ? SHORT[short[1]!] : undefined;
    if (!long && !short) {
      positionals.push(a);
      continue;
    }
    if (!name) throw new UsageError(`Unknown option ${a}.`);
    if (BOOLEAN.has(name)) {
      if (long?.[2] !== undefined) throw new UsageError(`--${name} takes no value.`);
      push(name, 'true');
    } else if (VALUED.has(name)) {
      const v = long?.[2] ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value.`);
      push(name, v);
    } else {
      throw new UsageError(`Unknown option --${name}.`);
    }
  }
  return { command: positionals.shift() ?? null, positionals, flags };
}

class UsageError extends Error {}

const flag = (p: Parsed, k: string) => p.flags.has(k);
const value = (p: Parsed, k: string) => p.flags.get(k)?.at(-1);

/**
 * Credentials for the CLI. Generated clients read SWFTE_API_KEY whether it
 * holds an API key or a PAT, so the CLI accepts either there too (loadConfig
 * alone would reject a PAT in SWFTE_API_KEY). With both set, SWFTE_PAT wins.
 */
export function cliConfig(env: NodeJS.ProcessEnv, lockBaseUrl?: string): ServerConfig {
  const pat = env.SWFTE_PAT?.trim();
  const key = env.SWFTE_API_KEY?.trim();
  const secret = pat || key;
  const mapped: NodeJS.ProcessEnv = {
    ...env,
    SWFTE_PAT: secret?.startsWith('pat_') ? secret : undefined,
    SWFTE_API_KEY: secret && !secret.startsWith('pat_') ? secret : undefined,
    SWFTE_BASE_URL: env.SWFTE_BASE_URL?.trim() || lockBaseUrl || undefined,
  };
  return loadConfig(mapped);
}

function projectRoot(io: CliIO, p: Parsed): string {
  const dir = resolve(io.cwd, value(p, 'cwd') ?? '.');
  try {
    return realpathSync(dir);
  } catch {
    throw new UsageError(`--cwd ${dir} does not exist.`);
  }
}

/** swfte.json's baseUrl, read before credentials so a repo pinned to a non-default API needs no extra env. */
function peekBaseUrl(root: string): string | undefined {
  try {
    const loaded = loadLock(new ConfinedWriter({ root }), { baseUrl: '' });
    return loaded.exists && loaded.lock.baseUrl ? loaded.lock.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

function printSync(io: CliIO, res: SyncResult): void {
  for (const e of res.entries) {
    const mark = { unchanged: '=', regenerated: '~', restored: '+', 'blocked-breaking': '!', 'blocked-reapproval': '!', 'blocked-edited': '!', error: 'x' }[e.status];
    io.out(`${mark} ${e.alias} (${e.language}, ${e.catalogRef}): ${e.message}`);
    if (e.diff && e.status !== 'regenerated') io.out(`    diff: ${e.diff}`);
    if (e.capabilityChanges.length) io.out(`    capability changes: ${e.capabilityChanges.join('; ')}`);
  }
  for (const f of res.files.filter((x) => x.action !== 'unchanged')) io.out(`  ${f.action.padEnd(9)} ${f.path}`);
  io.out(res.summary);
}

function printVerify(io: CliIO, r: VerifyReport): void {
  for (const p of r.problems) io.err(`✗ [${p.kind}] ${p.alias ? `${p.alias}: ` : ''}${p.detail}\n    fix: ${p.fix}`);
  for (const w of r.warnings) io.err(`! ${w}`);
  if (r.ok) io.out(`SWFTE_VERIFY_OK ${r.artifacts} artifact(s) in sync${r.remoteChecked ? ', no breaking upgrades or re-approvals pending' : ' (local check only)'}.`);
  else io.out(r.exitCode === 2 ? 'SWFTE_VERIFY_UNCHECKED — could not complete the check (exit 2).' : `SWFTE_VERIFY_FAILED — ${r.problems.filter((p) => p.kind !== 'unreachable').length} problem(s) (exit 1).`);
}

/** Runs one CLI invocation; returns the process exit code. Never calls process.exit, so tests can drive it. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (flag(p, 'version')) {
    io.out(PACKAGE_VERSION);
    return 0;
  }
  if (!p.command || flag(p, 'help') || p.command === 'help') {
    io.out(USAGE);
    return p.command || flag(p, 'help') ? 0 : 2;
  }
  const json = flag(p, 'json');
  const emit = (obj: unknown) => io.out(JSON.stringify(obj, null, 2));

  try {
    const root = projectRoot(io, p);
    const needsNetwork = !(p.command === 'verify' && flag(p, 'offline'));
    let config: ServerConfig | null = null;
    if (needsNetwork) {
      try {
        config = cliConfig(io.env, peekBaseUrl(root));
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        if (p.command !== 'verify') throw err;
        // verify without a credential still checks local drift, and says it could not check the rest.
      }
    }
    const writer = new ConfinedWriter({ root, forbidden: config ? [config.credential] : [] });
    const client = config ? new SwfteClient(config) : null;

    switch (p.command) {
      case 'add': {
        const ref = p.positionals[0];
        if (!ref || p.positionals.length > 1) throw new UsageError('swfte add takes exactly one <catalogRef>.');
        const framework = value(p, 'framework');
        if (framework && !(FRAMEWORKS as readonly string[]).includes(framework)) throw new UsageError(`--framework must be one of ${FRAMEWORKS.join(', ')}.`);
        const language = value(p, 'language');
        if (language && language !== 'typescript' && language !== 'python') throw new UsageError('--language must be typescript or python.');
        const res = await bakeArtifact(
          { client: client!, config: config!, writer },
          { catalogRef: ref, framework: framework as Framework | undefined, language: language as 'typescript' | 'python' | undefined, outDir: value(p, 'out'), alias: value(p, 'alias'), force: flag(p, 'force') }
        );
        if (json) emit(res);
        else {
          io.out(`Added ${res.catalogRef} as "${res.alias}" (${res.framework}${res.detection ? `, detected: ${res.detection.signals[0] ?? res.detection.detected}` : ''}).`);
          for (const f of res.files) io.out(`  ${f.action.padEnd(9)} ${f.path}`);
          if (res.contractHashWarning) io.err(`! ${res.contractHashWarning}`);
          if (res.contractChanged) io.err(`! ${res.contractChanged.note}`);
          if (res.lock.legacySources.length) io.out(`Migrated ${res.lock.legacySources.join(', ')} into swfte.json — delete the old file(s).`);
          io.out(`Use: ${res.usage}`);
          io.out(`Evidence: ${res.evidenceLevel}. Set SWFTE_API_KEY in your real env; commit swfte.json and add \`swfte verify\` to CI.`);
        }
        return 0;
      }
      case 'sync': {
        if (p.positionals.length) throw new UsageError('swfte sync takes no positional arguments (use --alias).');
        const res = await syncProject({ client: client!, config: config!, writer }, { aliases: p.flags.get('alias'), dryRun: flag(p, 'dry-run'), force: flag(p, 'force') });
        if (json) emit(res);
        else printSync(io, res);
        return res.entries.some((e) => e.status === 'error') ? 1 : 0;
      }
      case 'upgrade': {
        const alias = p.positionals[0];
        if (!alias || p.positionals.length > 1) throw new UsageError('swfte upgrade takes exactly one <alias> (see swfte.json).');
        const res = await upgradeAlias({ client: client!, config: config!, writer }, alias, {
          acceptCapabilityChanges: flag(p, 'accept-capability-changes'),
          force: flag(p, 'force'),
          dryRun: flag(p, 'dry-run'),
        });
        if (json) emit(res);
        else printSync(io, res);
        return res.entries.some((e) => e.status === 'error' || e.status.startsWith('blocked')) ? 1 : 0;
      }
      case 'verify': {
        if (p.positionals.length) throw new UsageError('swfte verify takes no positional arguments.');
        const report = await verifyProject({ client, config: config ?? undefined, writer }, { offline: flag(p, 'offline') });
        if (json) emit({ ...report, verdict: report.ok ? 'SWFTE_VERIFY_OK' : report.exitCode === 2 ? 'SWFTE_VERIFY_UNCHECKED' : 'SWFTE_VERIFY_FAILED' });
        else printVerify(io, report);
        return report.exitCode;
      }
      default:
        throw new UsageError(`Unknown command "${p.command}".`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof ConfigError) {
      io.err(`Configuration: ${err.message}`);
      return 2;
    }
    if (err instanceof SwfteApiError) {
      io.err(`Swfte API ${err.status} ${err.code}: ${err.message}${err.suggestedAction ? `\n  ${err.suggestedAction}` : ''}`);
      return 1;
    }
    if (err instanceof OverwriteRefusedError || err instanceof PathConfinementError || err instanceof LockError) {
      io.err(err.message);
      return 1;
    }
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** Process entry: `swfte …`, or `swfte-mcp-server swfte …` via src/index.ts. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const code = await runCli(argv, {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    env: process.env,
    cwd: process.cwd(),
  });
  process.exitCode = code;
}
