/** Types for the vendored read-only REST client. See rules.d.mts for why these are declared, not ported. */
export type GetOptions = { timeoutMs?: number };
export function get(path: string, opts?: GetOptions): Promise<unknown>;
export function tryGet(path: string, opts?: GetOptions): Promise<unknown>;
export function isError(v: unknown): boolean;
/** Bind a transport to a single async invocation. */
export function withTransport<T>(fn: (path: string, opts?: GetOptions) => Promise<unknown>, action: () => Promise<T>): Promise<T>;
