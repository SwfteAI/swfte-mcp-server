/** Types for the vendored read-only REST client. See rules.d.mts for why these are declared, not ported. */
export type GetOptions = { timeoutMs?: number };
export function get(path: string, opts?: GetOptions): Promise<unknown>;
export function tryGet(path: string, opts?: GetOptions): Promise<unknown>;
export function isError(v: unknown): boolean;
/** Hand in an already-authenticated GET. Pass null to fall back to env + fetch. */
export function setTransport(fn: ((path: string, opts?: GetOptions) => Promise<unknown>) | null): void;
