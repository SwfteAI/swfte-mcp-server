import type { Kind, KindAdapter } from './_adapter.js';
import { workflowAdapter } from './workflow.js';
import { agentAdapter } from './agent.js';
import { chatflowAdapter } from './chatflow.js';
import { widgetAdapter } from './widget.js';
import { applicationAdapter } from './application.js';
import { mcpServerAdapter } from './mcp-server.js';
import { moduleAdapter } from './module.js';
import { modelAdapter } from './model.js';

/**
 * Registry of every implemented kind. `swfte_build` and friends dispatch
 * through this, so adding a kind is one adapter file plus one line here — no
 * new tools and no change to the tool schemas beyond the widened enum.
 */
export const ADAPTERS: Partial<Record<Kind, KindAdapter>> = {
  workflow: workflowAdapter,
  agent: agentAdapter,
  chatflow: chatflowAdapter,
  widget: widgetAdapter,
  application: applicationAdapter,
  'mcp-server': mcpServerAdapter,
  module: moduleAdapter,
  model: modelAdapter,
  // `custom-node` is declared but not implemented: its wizard is SSE-only
  // (no async+poll pair), so it needs a different transport than every other
  // kind. getAdapter reports it as unimplemented rather than half-working.
};

export const IMPLEMENTED_KINDS = Object.keys(ADAPTERS) as Kind[];

/**
 * Kinds that can be generated from a description. Excludes model-vault models,
 * which are uploaded rather than written — advertising a `build` for those
 * would invite a call that could never work.
 */
export const BUILDABLE_KINDS = IMPLEMENTED_KINDS.filter(
  (k) => typeof ADAPTERS[k]?.build === 'function'
);

export class UnsupportedKindError extends Error {
  constructor(kind: string) {
    super(
      `No adapter for kind "${kind}". Implemented kinds: ${IMPLEMENTED_KINDS.join(', ')}.`
    );
    this.name = 'UnsupportedKindError';
  }
}

export class UnsupportedVerbError extends Error {
  constructor(kind: Kind, verb: string, note?: string) {
    super(
      `${kind} does not support "${verb}".${note ? ` ${note}` : ''}`
    );
    this.name = 'UnsupportedVerbError';
  }
}

export function getAdapter(kind: Kind): KindAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new UnsupportedKindError(kind);
  return adapter;
}

/** Fetch an adapter and assert it implements `verb`, with a useful message if not. */
export function requireVerb<K extends keyof KindAdapter>(
  kind: Kind,
  verb: K
): KindAdapter & Required<Pick<KindAdapter, K>> {
  const adapter = getAdapter(kind);
  if (typeof adapter[verb] !== 'function') {
    throw new UnsupportedVerbError(kind, String(verb), adapter.notes);
  }
  return adapter as KindAdapter & Required<Pick<KindAdapter, K>>;
}

export * from './_adapter.js';
export { linkAgentKnowledge, linkAgentTools, updateAgent } from './agent.js';
export { analyseGraph } from './workflow.js';
