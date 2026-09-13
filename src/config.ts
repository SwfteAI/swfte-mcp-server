/**
 * Server configuration and credential resolution.
 *
 * Two credential kinds are supported, and the distinction matters on the wire:
 *
 * - **PAT** (`pat_…`) — minted per user+workspace in Studio (Modules → any
 *   module → Documents → Connect CLI). agents-service `PersonalAccessTokenAuthFilter` claims `Bearer pat_…`
 *   and injects *trusted* `X-User-Id` / `X-Workspace-Id` / `X-Account-Id`
 *   headers that override anything we send, granting the full logged-in-studio-
 *   user authority set. So a PAT must travel in `Authorization` ONLY: copying it
 *   into `X-API-Key` just duplicates the secret into a second header, and
 *   sending our own `X-Workspace-ID` is at best ignored and at worst confusing
 *   when it disagrees with the token's binding.
 *
 * - **API key** (`sk-swfte-…` / `sk_…`) — workspace API key validated by
 *   `ApiKeyAuthFilter`, which runs BEFORE the PAT filter and claims only those
 *   two prefixes. These keys do travel in both headers, and DO want an explicit
 *   workspace id.
 */

/** Which credential family the configured secret belongs to. */
export type CredentialKind = 'pat' | 'api-key';

/**
 * Tool groups, used by `SWFTE_TOOLS` to trim the advertised surface. Some MCP
 * clients degrade badly past a few dozen tools, so a caller who only wants,
 * say, build+analytics can ask for exactly that.
 */
export const TOOL_GROUPS = [
  'custom-nodes',
  'apps', // Hosted AppWizard sessions; opt in explicitly or use all.
  'core', // whoami + the 8 ship tools + verify — the reason this server exists
  'workflows',
  'agents',
  'chatflows',
  'widgets',
  'datasets',
  'modules',
  'rag',
  'voice',
  'marketplace',
  'files',
  'conversations',
  'audit',
  'cost',
  'mcp',
  'analytics',
  'experiments',
  'connect',
  'deployments',
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/**
 * Groups advertised when `SWFTE_TOOLS` is unset.
 *
 * The full surface is ~119 tools, which measurably degrades a model's ability
 * to pick the right one. This subset covers building, shipping, and inspecting
 * the artifacts people actually reach for; the rest stay one env var away.
 * `SWFTE_TOOLS=all` advertises everything, and `swfte_whoami` reports which
 * groups are live so nothing is hidden silently.
 */
export const DEFAULT_GROUPS: ToolGroup[] = [
  'core',
  'workflows',
  'agents',
  'chatflows',
  'datasets',
  'modules',
  'deployments',
  'analytics',
  // Small (5 tools) and load-bearing: this is the only way to get a user signed
  // in to a provider their workflow needs. Hidden, an agent cannot repair — or
  // even name — a missing credential, so an integration workflow fails at
  // execution with nothing actionable to say. The tool-count argument for
  // trimming the surface does not apply to the tools that make the advertised
  // ones work.
  'connect',
];

export interface ServerConfig {
  /** The raw secret. Never logged. */
  credential: string;
  credentialKind: CredentialKind;
  baseUrl: string;
  /**
   * Explicit workspace id. Meaningful for API keys; for PATs the token's own
   * binding wins server-side, and we keep this only for display.
   */
  workspaceId?: string;
  userAgent: string;
  debug: boolean;
  /** Enabled tool groups. Empty set means "all". */
  enabledGroups: Set<ToolGroup>;
  /**
   * Whether `swfte_deploy` may actually provision infrastructure. Defaults to
   * false: deploys cost real money, and an unattended agent loop should not be
   * able to spin up paid capacity on its own. Preview always works.
   */
  allowDeploy: boolean;
  /** Default ceiling (ms) for tools that poll a long-running job to terminal. */
  defaultWaitMs: number;
}

const PAT_PREFIX = 'pat_';
const API_KEY_PREFIXES = ['sk-swfte-', 'sk_'];

export function detectCredentialKind(secret: string): CredentialKind | null {
  if (secret.startsWith(PAT_PREFIX)) return 'pat';
  if (API_KEY_PREFIXES.some((p) => secret.startsWith(p))) return 'api-key';
  return null;
}

export class ConfigError extends Error {}

function parseGroups(raw: string | undefined): Set<ToolGroup> {
  if (!raw || !raw.trim()) return new Set(DEFAULT_GROUPS);

  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // An empty set means "no filter" downstream, i.e. advertise everything.
  if (requested.includes('all') || requested.includes('*')) return new Set();

  const known = new Set<string>(TOOL_GROUPS);
  const unknown = requested.filter((g) => !known.has(g));
  if (unknown.length > 0) {
    throw new ConfigError(
      `SWFTE_TOOLS contains unknown group(s): ${unknown.join(', ')}.\n` +
        `Valid groups: ${TOOL_GROUPS.join(', ')}\n` +
        'Use "all" to advertise every tool.'
    );
  }

  const groups = new Set(requested as ToolGroup[]);
  // `core` is what makes this server worth attaching; silently including it
  // beats a caller wondering where swfte_build went.
  groups.add('core');
  return groups;
}

function parseWaitMs(raw: string | undefined): number {
  if (!raw) return 240_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`SWFTE_DEFAULT_WAIT_MS must be a positive number, got: ${raw}`);
  }
  return n;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const isTrue = (v: string | undefined): boolean => TRUE_VALUES.has((v ?? '').toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const pat = env.SWFTE_PAT?.trim();
  const apiKey = env.SWFTE_API_KEY?.trim();

  if (pat && apiKey) {
    throw new ConfigError(
      'Both SWFTE_PAT and SWFTE_API_KEY are set. Configure exactly one — they authenticate ' +
        'as different principals (a PAT acts as you; an API key acts as the workspace).'
    );
  }

  const secret = pat ?? apiKey;
  if (!secret) {
    throw new ConfigError(
      'No credential configured. Set one of:\n' +
        '  SWFTE_PAT=pat_…       Personal access token — acts as you, full studio-user access.\n' +
        '                        Mint one in Studio → Modules → any module → Documents\n' +
        '                        → Connect CLI.\n' +
        '  SWFTE_API_KEY=sk_…    Workspace API key, for shared/service usage.'
    );
  }

  const detected = detectCredentialKind(secret);
  if (!detected) {
    throw new ConfigError(
      `Unrecognised credential format (starts with "${secret.slice(0, 4)}…"). ` +
        'Expected a PAT (pat_…) or an API key (sk-swfte-… / sk_…).'
    );
  }

  // Catch the swapped-variable mistake explicitly. Without this the request
  // simply 401s and the user has no idea which of the two knobs is wrong.
  if (pat && detected !== 'pat') {
    throw new ConfigError(
      'SWFTE_PAT does not look like a personal access token (expected a `pat_` prefix). ' +
        'If this is a workspace API key, set SWFTE_API_KEY instead.'
    );
  }
  if (apiKey && detected !== 'api-key') {
    throw new ConfigError(
      'SWFTE_API_KEY looks like a personal access token (`pat_` prefix). ' +
        'Set SWFTE_PAT instead — PATs authenticate as a user, not as the workspace.'
    );
  }

  return {
    credential: secret,
    credentialKind: detected,
    baseUrl: (env.SWFTE_BASE_URL ?? 'https://api.swfte.com/agents').replace(/\/+$/, ''),
    workspaceId: env.SWFTE_WORKSPACE_ID?.trim() || undefined,
    userAgent: `swfte-mcp-server/${env.SWFTE_MCP_VERSION ?? '0.2.0'} (+https://www.swfte.com)`,
    debug: isTrue(env.SWFTE_DEBUG),
    enabledGroups: parseGroups(env.SWFTE_TOOLS),
    allowDeploy: isTrue(env.SWFTE_ALLOW_DEPLOY),
    defaultWaitMs: parseWaitMs(env.SWFTE_DEFAULT_WAIT_MS),
  };
}
