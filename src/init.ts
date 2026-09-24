/**
 * `swfte init` — set a repository up for baked Swfte artifacts (developer path).
 *
 * Writes swfte.json (empty, v1) and the env *names* into .env.example, detects
 * the stack, and guides credential creation. The guidance prefers a
 * per-artifact scoped API key (`POST /v1/api-keys` with `resourceScopes`: the
 * key can invoke only those catalogRefs, 403 elsewhere) over a personal access
 * token, which acts as a person with everything they can reach.
 *
 * It never writes a credential anywhere: no flag takes one, the writer refuses
 * any content carrying the credentials in the environment or anything
 * secret-shaped, and the only env file it touches is .env.example (names only).
 */
import { CLIENT_ENV } from './bake.js';
import { ConfinedWriter, gitignoreCovers, type PlannedWrite } from './fsguard.js';
import { assertLockBaseUrl } from './hosts.js';
import { loadLock, LOCK_FILE, planLockWrite } from './lock.js';
import { detectStack, type StackDetection } from './stack.js';

export const DEFAULT_BASE_URL = 'https://api.swfte.com/agents';

export type CredentialKind = 'none' | 'pat' | 'api-key' | 'unknown';

export interface InitResult {
  lock: { path: string; created: boolean; baseUrl: string; workspaceId: string | null; artifacts: number };
  detection: Pick<StackDetection, 'framework' | 'detected' | 'signals'>;
  files: PlannedWrite[];
  credential: { kind: CredentialKind; advice: string[] };
  gitignore: { envCovered: boolean; missing: string[] };
  nextSteps: string[];
}

function credentialKind(env: NodeJS.ProcessEnv): CredentialKind {
  const v = (env.SWFTE_API_KEY || env.SWFTE_PAT || '').trim();
  if (!v) return 'none';
  if (v.startsWith('pat_')) return 'pat';
  if (/^(sk-swfte-|sk_|swfte_sk_)/.test(v)) return 'api-key';
  return 'unknown';
}

/** The request that mints a key able to call only `refs` — shown, never run, and never with a real token. */
export function scopedKeyRequest(baseUrl: string, refs: string[], name: string): string {
  const scopes = refs.length ? refs : ['<kind>:<id>'];
  const body = JSON.stringify({ name, resourceScopes: scopes });
  return `curl -sS -X POST "${baseUrl.replace(/\/+$/, '')}/v1/api-keys" -H "Authorization: Bearer $SWFTE_PAT" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`;
}

export function initProject(opts: { root: string; env: NodeJS.ProcessEnv; baseUrl?: string; workspaceId?: string; projectName?: string }): InitResult {
  const env = opts.env;
  // Anything credential-valued in the environment is forbidden content for every file written here.
  const forbidden = [env.SWFTE_PAT, env.SWFTE_API_KEY].map((v) => v?.trim()).filter((v): v is string => Boolean(v));
  const writer = new ConfinedWriter({ root: opts.root, forbidden });
  const trusted = (env.SWFTE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const baseUrl = (opts.baseUrl?.trim() || trusted).replace(/\/+$/, '');
  // A committed baseUrl receives every adopter's key at runtime: same allow-list as the rest of the CLI (H1).
  assertLockBaseUrl(baseUrl, env, opts.baseUrl ? undefined : trusted);

  const loaded = loadLock(writer, { baseUrl, workspaceId: opts.workspaceId ?? env.SWFTE_WORKSPACE_ID?.trim() ?? null });
  const created = !loaded.exists;
  if (created || loaded.migrated) planLockWrite(writer, loaded.lock);
  writer.mergeEnv(writer.resolve('.env.example'), CLIENT_ENV, { header: 'Swfte — read by generated clients (swfte add)' });
  const files = writer.commit();

  const detection = detectStack(writer.root);
  const lock = loaded.lock;
  const refs = [...new Set(lock.artifacts.map((a) => a.catalogRef))];
  const kind = credentialKind(env);
  const keyName = `${opts.projectName || 'app'} (swfte)`;
  const mint = scopedKeyRequest(lock.baseUrl || baseUrl, refs, keyName);
  const advice: string[] = [];
  if (kind === 'pat') {
    advice.push(
      'SWFTE_PAT/SWFTE_API_KEY holds a personal access token (pat_…). It acts as you, with everything you can reach — fine for the CLI on your machine, wrong for app code or CI.',
      'For the app, mint a key scoped to the artifacts it calls (it gets 403 anywhere else):',
      `  ${mint}`
    );
  } else if (kind === 'api-key') {
    advice.push(
      'An API key is set. Make sure it is scoped to the artifacts this code calls (Studio → Settings → API keys → Resource scopes), so a leak cannot reach the rest of the workspace.'
    );
  } else if (kind === 'unknown') {
    advice.push('SWFTE_API_KEY is set but does not look like a Swfte key (sk-swfte-… or pat_…). Check it.');
  } else {
    advice.push(
      'No credential in the environment. Prefer a per-artifact scoped API key over a personal access token:',
      '  Studio → Settings → API keys → New key → Resource scopes: the catalogRefs in swfte.json, or',
      `  ${mint}`,
      'Put it in your secret store (CI secret, hosting env, a git-ignored .env.local) as SWFTE_API_KEY. swfte never writes it to a file.'
    );
  }

  const missing = ['.env', '.env.local'].filter((f) => !gitignoreCovers(writer.root, f));
  const nextSteps = [
    ...(lock.artifacts.length ? [] : ['Find something to reuse (swfte_find_existing in your MCP client, or the Studio hub), then `swfte add <kind>:<id>`.']),
    'Commit swfte.json and .env.example; add `npx -p @swfte/mcp-server swfte verify` to CI.',
    'Run the app offline against local fixtures: `swfte dev` (SWFTE_BASE_URL=http://127.0.0.1:4010).',
    ...(missing.length ? [`Add ${missing.join(' and ')} to .gitignore before putting a key in ${missing.length > 1 ? 'them' : 'it'}.`] : []),
  ];
  return {
    lock: { path: LOCK_FILE, created, baseUrl: lock.baseUrl, workspaceId: lock.workspaceId, artifacts: lock.artifacts.length },
    detection: { framework: detection.framework, detected: detection.detected, signals: detection.signals },
    files,
    credential: { kind, advice },
    gitignore: { envCovered: missing.length === 0, missing },
    nextSteps,
  };
}
