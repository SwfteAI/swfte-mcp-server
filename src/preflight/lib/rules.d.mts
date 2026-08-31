/**
 * Types for the vendored rule set.
 *
 * The rule bodies stay in plain `.mjs`, byte-identical to the engagement
 * original, and are NOT ported to TypeScript. A port is a rewrite, and a
 * rewrite is exactly how a rule quietly stops firing — the failure this whole
 * tool exists to prevent. Types are declared alongside instead.
 */

export interface Finding {
  rule: string;
  severity: 'block' | 'warn';
  catalogue: number | null;
  where: string;
  detail: string;
  fix?: string;
}

export interface SkipMarker {
  $skip: string;
}

export interface Rule {
  id: string;
  catalogue: number | null;
  severity: 'block' | 'warn';
  title: string;
  needs: string[];
  run(snap: unknown): Finding[] | SkipMarker | undefined;
}

export const RULES: Rule[];

export function tokensIn(v: unknown): string[];
export function hasToken(v: unknown): boolean;
export function stripComments(code: string): string;
export function returnedKeys(rawCode: unknown): string[];
export function editDistance(a: string, b: string): number;
export function allNodes(snap: unknown): Generator<{ wf: unknown; nid: string; node: unknown }>;
export function resolveWire(
  from: unknown,
  to: unknown,
  wire: unknown,
  snap: unknown
): { state: 'connected' | 'broken' | 'inert' | 'unknown'; detail?: string; fix?: string };
export function emitsJsonText(srcNode: unknown, path: string): boolean;
export function project(record: unknown, selector: string): unknown;
export function skip(reason: string): SkipMarker;
