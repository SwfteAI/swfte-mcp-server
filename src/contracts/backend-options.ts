/**
 * Typed accessors over `backend-options.json`.
 *
 * Every enumerated option this server advertises that is *also* an enumerated
 * contract in agents-service lives in that JSON file, with provenance pointing
 * at the Java source it was read from. Tools import from here rather than
 * restating string literals, for two reasons:
 *
 *  1. An option that drifts from the backend turns a tool call into a 400 the
 *     model cannot diagnose ("Unsupported widget viewType" says nothing about
 *     which values *are* supported). One list, one fix.
 *  2. Provenance makes the alignment checkable without running either codebase:
 *     `verify-options-aligned.mjs` re-derives each backend set from the named
 *     Java file and compares.
 *
 * Values that are NOT backend enums (tool-local vocabularies like the
 * composition classifier's own axes) deliberately stay out of this file — there
 * is nothing to align them against.
 */
import { z } from 'zod';
import contract from './backend-options.json';

type OptionKey = keyof typeof contract.options;

function values(key: OptionKey): [string, ...string[]] {
  const entry = contract.options[key] as { values: string[] };
  const list = entry.values;
  if (!list?.length) throw new Error(`backend-options.json: "${key}" has no values.`);
  return list as [string, ...string[]];
}

/** A zod enum over one governed option list. */
function enumOf(key: OptionKey) {
  return z.enum(values(key));
}

// --- Widgets --------------------------------------------------------------
export const WIDGET_VIEW_TYPES = values('widget.viewType');
export const WIDGET_BINDINGS = values('widget.binding');
export const WIDGET_STATE_SCOPES = values('widget.stateScope');
export const WIDGET_BRAIN_KINDS = values('widget.brainKind');
export const WIDGET_BINDING_SOURCE_TYPES = values('widget.bindingSourceType');

export const WidgetViewTypeEnum = enumOf('widget.viewType');
export const WidgetBindingEnum = enumOf('widget.binding');
export const WidgetStateScopeEnum = enumOf('widget.stateScope');
export const WidgetBrainKindEnum = enumOf('widget.brainKind');
export const WidgetBindingSourceTypeEnum = enumOf('widget.bindingSourceType');

/**
 * Source types that persist but have no registered `WidgetDataSourceAdapter`,
 * so `WidgetDataBindingResolver.resolve` returns empty and the widget serves the
 * last stored snapshot instead of live rows. Callers are told this rather than
 * left to infer it from an empty table.
 */
export const UNRESOLVED_BINDING_SOURCE_TYPES: readonly string[] =
  (contract.options['widget.bindingSourceType'] as any).persistedButUnresolved?.values ?? [];

// --- Chatflows ------------------------------------------------------------
export const CHATFLOW_CHANNELS = values('chatflow.channel');
export const CHATFLOW_INPUT_TYPES = values('chatflow.inputType');
export const ChatflowChannelEnum = enumOf('chatflow.channel');
export const ChatflowInputTypeEnum = enumOf('chatflow.inputType');

// --- Deployment -----------------------------------------------------------
export const DEPLOY_OPTIONS = values('deploy.option');
export const DEPLOY_PROVIDERS = values('deploy.provider');
export const DEPLOY_LIFECYCLES = values('deploy.lifecycle');
export const DEPLOY_PATHS = values('deploy.path');
export const GPU_TIERS = values('deploy.gpuTier');
export const DEPLOY_PHASES = values('deploy.phase');

export const DeployProviderEnum = enumOf('deploy.provider');
export const DeployLifecycleEnum = enumOf('deploy.lifecycle');
export const DeployPathEnum = enumOf('deploy.path');
export const GpuTierEnum = enumOf('deploy.gpuTier');

/** Short aliases accepted alongside the wire values the UI sends. */
export const DEPLOY_OPTION_ALIASES: Readonly<Record<string, string>> =
  (contract.options['deploy.option'] as any).aliases ?? {};

/** Both spellings, so an MCP caller and the deploy modal can say the same thing. */
export const DeployOptionEnum = z.enum([
  ...DEPLOY_OPTIONS,
  ...Object.keys(DEPLOY_OPTION_ALIASES),
] as [string, ...string[]]);

/** Normalise either spelling to the wire value `DeployOption.fromWire` accepts. */
export function toWireDeployOption(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if ((DEPLOY_OPTIONS as readonly string[]).includes(value)) return value;
  const mapped = DEPLOY_OPTION_ALIASES[value];
  if (!mapped) {
    throw new Error(
      `UNSUPPORTED_DEPLOY_OPTION: "${value}". Use ${DEPLOY_OPTIONS.join(' | ')} ` +
        `(or the aliases ${Object.keys(DEPLOY_OPTION_ALIASES).join(' | ')}).`
    );
  }
  return mapped;
}

/**
 * Phases after which no further transition is expected.
 *
 * Read from the contract rather than guessed: `derivePhase` maps STOPPING and
 * TERMINATING onto phase TERMINATED while `isTerminal` still reports false, so
 * a poller that trusts the phase alone declares a shutting-down deployment
 * finished. Prefer the response's own `terminal` boolean; this set is the
 * fallback for responses that do not carry one.
 */
export const TERMINAL_DEPLOY_PHASES: ReadonlySet<string> = new Set(
  (contract.options['deploy.phase'] as any).terminalValues as string[]
);

// --- Datasets, custom nodes, applications ---------------------------------
export const INDEXING_TECHNIQUES = values('dataset.indexingTechnique');
export const CUSTOM_NODE_MODES = values('customNode.mode');
export const APP_FRAMEWORKS = values('app.framework');

export const IndexingTechniqueEnum = enumOf('dataset.indexingTechnique');
export const CustomNodeModeEnum = enumOf('customNode.mode');
export const AppFrameworkEnum = enumOf('app.framework');

/** The whole contract, for `swfte_capabilities` to report verbatim. */
export const BACKEND_OPTION_CONTRACT = contract;
