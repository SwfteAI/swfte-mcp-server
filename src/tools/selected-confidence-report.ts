import { z } from 'zod';
import type { ToolDefinition } from './_types.js';
import type { SwfteClient } from '../client.js';
import { admitConfidenceResult } from './prove.js';
import { setupContractInstant } from './_resolver-session.js';
import { CONFIDENCE_ARTIFACT_KINDS } from '../contracts/confidence-runtime-v1.js';

const text = z.string().min(1).refine(value => !/^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/u.test(value));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const sequence = z.number().int().nonnegative().safe();
const runIdentifier = text.refine(value => value.length <= 200 && /^[A-Za-z0-9_:@./-]+$/.test(value)
  && !value.includes('://') && !value.startsWith('/') && !value.includes('..'));
const sections = ['SUMMARY', 'WHAT_WAS_RUN', 'FINDINGS', 'COVERAGE_MAP', 'COMPLIANCE', 'PERFORMANCE_COST', 'BEHAVIOUR', 'CHANGES_SINCE', 'HOW_AND_WHY', 'CLAIMS_BOUNDARY'] as const;
const dimension = z.enum(['FUNCTION', 'COMPLETENESS', 'ROBUSTNESS', 'LOAD_COST', 'SECURITY', 'PRIVACY', 'COMPLIANCE', 'BEHAVIOUR']);
const unknownReason = z.enum(['NOT_EXERCISED', 'CRASHED', 'NO_VERDICT', 'CASSETTE_BROKEN', 'UNASSESSED_CONTROL', 'UNCALIBRATED_GRADER', 'BUDGET', 'LANE_UNVERIFIED', 'STALE']);
const inputSchema = z.object({
  runId: runIdentifier, seq: sequence,
  expectedContentHash: hash.optional(), expectedAvailableVersion: text.optional(),
}).strict();
const reportSchema = z.object({
  runId: text, contentHash: hash, generatedAt: setupContractInstant,
  baselineContentHash: hash.nullish(),
  sections: z.array(z.object({ id: z.enum(sections), title: text, markdown: z.string(), data: z.record(z.unknown()) }).passthrough()),
  unknowns: z.array(z.object({ elementId: text, dimension, reason: unknownReason, title: text, detail: text }).passthrough()),
  droppedSentences: z.array(z.object({ section: z.enum(sections), sentenceHash: hash, reason: text }).passthrough()).nullish(),
  claimsBoundary: z.literal('Supports your audit; not an audit opinion.'), reportHash: hash,
}).passthrough();
const selectedSchema = z.object({
  runId: text, selectedSeq: sequence, storedRevision: sequence,
  artifactKind: z.enum(CONFIDENCE_ARTIFACT_KINDS), artifactId: text, contentHash: hash,
  availableVersion: text.nullable(), result: z.unknown(), rawReport: reportSchema,
  reportHash: hash, reportIntegrity: z.literal('CANONICAL_HASH_VERIFIED'),
  signatureStatus: z.enum(['UNSIGNED', 'UNVERIFIED']), signatureValidation: z.literal('UNAVAILABLE'),
}).passthrough();

/** The parsed projection admits known fields; the server performs canonical seal/evidence verification. */
export function admitSelectedConfidenceReport(wire: unknown, selection: z.infer<typeof inputSchema>, client: SwfteClient, workspace: string): unknown {
  const selected = selectedSchema.parse(wire);
  const result = admitConfidenceResult(selected.result, client, selection.runId);
  const report = selected.rawReport;
  if (selected.runId !== selection.runId || selected.selectedSeq !== selection.seq
      || result.run.workspaceId !== workspace || selected.artifactKind !== result.run.artifactKind
      || selected.artifactId !== result.run.artifactId || selected.contentHash !== result.run.contentHash
      || report.runId !== selected.runId || report.contentHash !== selected.contentHash || report.reportHash !== selected.reportHash
      || selection.expectedContentHash !== undefined && selection.expectedContentHash !== selected.contentHash
      || selection.expectedAvailableVersion !== undefined && selection.expectedAvailableVersion !== selected.availableVersion) {
    throw new Error('SELECTED_CONFIDENCE_BINDING_MISMATCH');
  }
  if (!['COMPLETE', 'FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED'].includes(result.run.status)
      || report.sections.length !== sections.length || report.sections.some((section, index) => section.id !== sections[index])) {
    throw new Error('SELECTED_CONFIDENCE_REPORT_NOT_READY');
  }
  // This projection may round additive numeric values. The tool emits the original
  // response text after admission, preserving those values and the server seal.
  return wire;
}

export const selectedConfidenceReportTools: ToolDefinition[] = [{
  name: 'swfte_prove_selected_report', title: 'Read one selected confidence report', readOnly: true,
  description: 'Read the actual canonical selected run and sequence through the coherent report provider. Returns its original JSON text, including the typed result, all ten sections, Unknown items and additive raw report from one persisted revision. Numeric values and the server seal are preserved in this text; callers parsing it choose their own numeric precision. Server integrity admission does not establish an external signature; signature validation remains unavailable. This never issues proof, starts work or approves promotion.',
  inputSchema,
  execute: async (input, { client }) => {
    const identity = z.object({ workspaceId: text, actorId: text }).strict().parse(
      await client.request({ method: 'GET', path: '/v2/confidence/identity', retries: 0 }));
    if (client.configuredWorkspaceId !== undefined && identity.workspaceId !== client.configuredWorkspaceId) {
      throw new Error('SELECTED_CONFIDENCE_WORKSPACE_MISMATCH');
    }
    const wire = await client.requestSelectedConfidenceReportWire(input.runId, input);
    admitSelectedConfidenceReport(wire.parsed, input, client, identity.workspaceId);
    return wire.text;
  },
}];
