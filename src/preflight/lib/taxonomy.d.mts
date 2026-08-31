/** Types for the vendored node-type taxonomy. See rules.d.mts for why these are declared, not ported. */
export const CORE: Set<string>;
export const OUTBOUND: Set<string>;
export const RESULT_ROOTED: Set<string>;
export function classify(type: unknown): 'core' | 'outbound' | 'integration';
