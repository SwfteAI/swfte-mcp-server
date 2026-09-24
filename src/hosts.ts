/**
 * Which hosts may receive a Swfte credential (black-hat finding H1).
 *
 * `swfte.json` is a committed file, so anyone who can open a pull request can
 * edit its `baseUrl`. If the CLI believed it, a CI job running `swfte verify`
 * with SWFTE_API_KEY set would send that key to the attacker's host, and
 * `swfte add` / `swfte sync` would bake the host into generated clients as
 * their default, so the application's own key would follow at runtime.
 *
 * The rule:
 *   - SWFTE_BASE_URL from the environment is trusted. The operator set it.
 *   - A base URL taken from the lock file is used only when its host is in the
 *     allow-list: SWFTE_ALLOWED_HOSTS (comma-separated; `*.example.com` matches
 *     subdomains) or, when that is unset, api.swfte.com, localhost and
 *     127.0.0.1. It must be https unless the host is loopback.
 *   - Anything else is refused with a message that says how to proceed. It is
 *     never silently replaced, because a silent substitute would hide the
 *     tampering from the person reading the CI log.
 */

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['api.swfte.com', 'localhost', '127.0.0.1'];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class UntrustedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntrustedHostError';
  }
}

/** The allow-list in force: SWFTE_ALLOWED_HOSTS when set, otherwise the default. */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SWFTE_ALLOWED_HOSTS;
  if (raw === undefined || !raw.trim()) return [...DEFAULT_ALLOWED_HOSTS];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(host: string, entry: string): boolean {
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === entry;
}

/** Why `url` may not receive a credential, or null when it may. */
export function hostRefusalReason(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'it is not a valid URL';
  }
  if (u.username || u.password) return 'it contains credentials (user:password@host)';
  const host = u.hostname.toLowerCase();
  const list = allowedHosts(env);
  if (!list.some((e) => hostMatches(host, e))) {
    return `host "${host}" is not in the allowed hosts (${list.join(', ')})`;
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(host))) {
    return `"${u.protocol}" is not allowed for host "${host}"; use https`;
  }
  return null;
}

export function isAllowedHost(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return hostRefusalReason(url, env) === null;
}

/**
 * The base URL a lock file names, vetted. `trustedBaseUrl` is the one that came
 * from the environment or the built-in default; a lock value equal to it is
 * fine whatever its host. Anything else must pass the allow-list.
 */
export function assertLockBaseUrl(lockBaseUrl: string, env: NodeJS.ProcessEnv = process.env, trustedBaseUrl?: string): string {
  const norm = (s: string) => s.replace(/\/+$/, '');
  if (trustedBaseUrl && norm(lockBaseUrl) === norm(trustedBaseUrl)) return lockBaseUrl;
  const reason = hostRefusalReason(lockBaseUrl, env);
  if (reason) {
    throw new UntrustedHostError(
      `Refusing to use swfte.json baseUrl "${lockBaseUrl.replace(/\/\/[^/@\s]*@/, '//[redacted]@')}": ${reason}. swfte.json is a committed file, so its ` +
        'baseUrl is not trusted with your credential. If this host is really yours, set SWFTE_BASE_URL in the ' +
        'environment, or add the host to SWFTE_ALLOWED_HOSTS (comma-separated). Otherwise restore baseUrl in swfte.json.'
    );
  }
  return lockBaseUrl;
}

/**
 * The base URL the CLI sends its credential to: SWFTE_BASE_URL from the
 * environment (trusted), else the lock's baseUrl when it passes the allow-list,
 * else undefined (the built-in default).
 */
export function credentialBaseUrl(env: NodeJS.ProcessEnv, lockBaseUrl: string | undefined): string | undefined {
  const fromEnv = env.SWFTE_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  if (!lockBaseUrl) return undefined;
  return assertLockBaseUrl(lockBaseUrl, env);
}
