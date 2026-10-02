/** Server-assigned semantic version identity. Preserve its exact text, never select live. */
export const SEMANTIC_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function semanticVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  // Preserve the entire literal identity; the matched substring must equal the input.
  return value.match(SEMANTIC_VERSION)?.[0] === value ? value : null;
}

export function numericVersion(value: number): string | null {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? String(value) : null;
}

/** Exact published-label syntax only; callers must still resolve server publication/ownership. */
export function literalRevision(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return null;
  return value.match(/^[A-Za-z0-9_.:@+-]+$/)?.[0] === value && /[A-Za-z0-9]/.test(value) ? value : null;
}

/** A literal URL segment may contain one normal URI-encoding layer. */
export function pathVersion(value: string | null | undefined): string | null {
  if (!value) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  return literalRevision(decoded);
}
