import { z } from 'zod';
import { CatalogRefArg } from '../catalog.js';
import { ContentHash, ScenarioDefinition, ShelfQuery, getCatalogProof, getCatalogDelta, getCatalogShelves,
  extendCatalogSuite, declareCatalogDeviation, rerunParentSuite } from '../catalog-proof.js';
import type { ToolDefinition } from './_types.js';

export const catalogProofTools: ToolDefinition[] = [
  { name: 'swfte_catalog_proof', title: 'Checks for catalog content', readOnly: true,
    description: 'Read hash-bound checks, the parent suite on a copy, separate own evidence, confidence report and bundle. ' +
      'Missing producer records remain dependency gaps. Declared coverage alone never grants a passing result.',
    inputSchema: z.object({ catalogRef: CatalogRefArg, contentHash: ContentHash, view: z.enum(['suite', 'delta']).default('suite') }).strict(),
    execute: (input, { client }) => input.view === 'delta' ? getCatalogDelta(client, input.catalogRef, input.contentHash) : getCatalogProof(client, input.catalogRef, input.contentHash) },
  { name: 'swfte_catalog_shelves', title: 'Industry and task shelves', readOnly: true,
    description: 'Read eligible catalog entries for an industry and task. Counts and ranking use each entry’s computed own evidence; private or stale entries are excluded.',
    inputSchema: ShelfQuery, execute: (input, { client }) => getCatalogShelves(client, input) },
  { name: 'swfte_extend_proof_suite', title: 'Extend a copy’s scenario suite',
    description: 'Add or modify scenario definitions with optimistic content and suite hashes. Inherited scenarios require a recorded deviation before replacement. This records no passing evidence.',
    inputSchema: z.object({ catalogRef: CatalogRefArg, expectedContentHash: ContentHash, expectedSuiteHash: ContentHash, scenarios: z.array(ScenarioDefinition).min(1).max(2000) }).strict(),
    execute: (input, { client }) => extendCatalogSuite(client, input.catalogRef, input) },
  { name: 'swfte_declare_deviation', title: 'Declare a change from an inherited scenario',
    description: 'Record a reason for retired inherited scenarios. The authenticated server actor owns the declaration. Changed paths still require measured delta scenarios.',
    inputSchema: z.object({ catalogRef: CatalogRefArg, expectedContentHash: ContentHash, expectedSuiteHash: ContentHash,
      scenarioIds: z.array(z.string().min(1).max(1000)).min(1).max(2000), reason: z.string().trim().min(1).max(1000) }).strict(),
    execute: (input, { client }) => declareCatalogDeviation(client, input.catalogRef, {
      expectedContentHash: input.expectedContentHash, expectedSuiteHash: input.expectedSuiteHash, scenarioIds: input.scenarioIds, reason: input.reason }) },
  { name: 'swfte_rerun_parent_suite', title: 'Propose the parent’s latest suite in sandbox',
    description: 'Propose a sandbox action for the parent’s publicly visible current suite on this copy. Does not merge, release or activate anything.',
    inputSchema: z.object({ catalogRef: CatalogRefArg, expectedContentHash: ContentHash, expectedParentSuiteHash: ContentHash }).strict(),
    execute: (input, { client }) => rerunParentSuite(client, input.catalogRef, input.expectedContentHash, input.expectedParentSuiteHash) },
];
