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
  'core', // ship/verify/solution/preflight + catalog reuse, scaffold, actions, wiring — always advertised
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
  // Managed agent mailboxes. Opt-in on purpose: one of its tools emails real
  // people, and it returns external message bodies that a model will read.
  'agent-mail',
  // Relay product surface. Registered so SWFTE_TOOLS can name them;
  // deliberately NOT in DEFAULT_GROUPS below — see the note there about the
  // tool-surface budget.
  'journeys',
  'relay',
  // Convenience variants of tools that are already advertised (same endpoint or
  // a subset of one). Out of DEFAULT_GROUPS so they do not spend the budget
  // twice; still reachable by name through SWFTE_TOOLS=…,extras.
  'extras',
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/**
 * Groups advertised when `SWFTE_TOOLS` is unset.
 *
 * The full surface is 230 tools, which measurably degrades a model's ability
 * to pick the right one (test/tools.test.ts "the budget comment carries the measured counts" keeps
 * these two numbers true). This subset covers building, shipping, and inspecting
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
  // `analytics` (13 read-only reporting tools) left the default set when the
  // eleven Studio-as-source-of-truth tools joined `core` (find_existing,
  // get_context, get_evidence, trace_dependencies, scaffold_client,
  // embed_widget, request_approval, execute_approved_action,
  // get_action_status, wire_analytics, wire_payments). Measured at that point:
  // 225 registered, 101 advertised against a ceiling of 103 —
  //   core 30, workflows 19, agents 12, chatflows 12, deployments 8,
  //   datasets 6, modules 6, connect 5, untagged 3.
  // Keeping analytics would have made it 114. None of its tools is needed to
  // build, reuse or ship anything; it was the lever the budget note in
  // test/tools.test.ts named. `SWFTE_TOOLS=core,…,analytics` brings it back.
  // Small (5 tools) and load-bearing: this is the only way to get a user signed
  // in to a provider their workflow needs. Hidden, an agent cannot repair — or
  // even name — a missing credential, so an integration workflow fails at
  // execution with nothing actionable to say. The tool-count argument for
  // trimming the surface does not apply to the tools that make the advertised
  // ones work.
  'connect',
  // Solution Hub + bake-in (leaf-1.2.4) added five `core` tools — fit_check,
  // adopt, get_timeline, sync, check_upgrades — without raising the ceiling:
  // three exact duplicates moved to the opt-in `extras` group
  // (swfte_workflows_executions_list = swfte_workflows_executions, same
  // endpoint; swfte_workflows_deployment_status_simple ⊂
  // swfte_workflows_deployment_status; swfte_deployments_count ⊂
  // swfte_deployments_list). Measured now: 230 registered, 103 advertised
  // against the ceiling of 103 —
  //   core 35, workflows 17, agents 12, chatflows 12, deployments 7,
  //   datasets 6, modules 6, connect 5, untagged 3.
  // The next addition has no duplicate left to trade; argue the number.
  // `journeys` and `relay` are deliberately absent, and that is a decision to
  // revisit rather than a default to inherit. The surface sits at 103 against
  // a ceiling of 103 — a ceiling that exists because a large advertised surface
  // measurably degrades a model's ability to pick the right tool. Adding them
  // (17 tools) would push well past it. They stay reachable through
  // SWFTE_TOOLS; whether an agent should reach for Relay tools unprompted is a
  // product question, not a merge resolution.
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
