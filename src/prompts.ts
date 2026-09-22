/**
 * MCP prompts: the three workflows this server exists for, as slash-command
 * style recipes a client can offer. Each one only sequences tools the server
 * already advertises; none of them grants anything a tool call would not.
 */

export interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  render: (args: Record<string, string | undefined>) => string;
}

const q = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

export const PROMPTS: PromptDef[] = [
  {
    name: 'reuse-then-build',
    title: 'Reuse a proven artifact, build only if nothing fits',
    description: 'Search the Studio catalog first; reuse the best-evidenced match, and generate only when nothing fits.',
    arguments: [
      { name: 'goal', description: 'What you need, in plain words.', required: true },
      { name: 'kind', description: 'Optional kind to restrict to (workflow, agent, chatflow, widget, application, ...).' },
    ],
    render: (a) =>
      [
        `Goal: ${q(a.goal, '(describe the goal)')}${a.kind ? ` (kind: ${a.kind})` : ''}.`,
        '',
        'Use Swfte Studio as the source of truth. Steps:',
        `1. Call swfte_find_existing with query "${q(a.goal, '')}"${a.kind ? ` and kinds ["${a.kind}"]` : ''}. Read each result's evidence level and reasons, and any \`degraded\` notes.`,
        '2. If the recommendation is REUSE (or INSPECT_BEFORE_REUSE), call swfte_get_context on that catalogRef. Check the contract fits the inputs/outputs you need and read the evidence reasons. Report the generation it avoided.',
        '3. If it fits, bake it into the codebase with swfte_scaffold_client (targetDir inside this project). Do not regenerate what already exists.',
        '4. Only if the recommendation is BUILD (or no candidate fits the contract): call swfte_solution_advise or swfte_composition_classify, then swfte_build, swfte_verify, and swfte_run on representative inputs.',
        '5. Before changing an artifact others reuse, run swfte_trace_dependencies direction "upstream".',
        'State which path you took and why, citing evidence levels rather than names.',
      ].join('\n'),
  },
  {
    name: 'ship-with-analytics-and-payments',
    title: 'Ship an app with analytics and payments wired',
    description: 'Wire Swfte analytics and payments into an application, through approval-gated actions, then preview the deploy.',
    arguments: [
      { name: 'catalogRef', description: 'The application, "application:<id>".', required: true },
      { name: 'targetDir', description: 'Directory inside the project for generated code (default "src/lib").' },
      { name: 'environment', description: 'development | staging | production (default development).' },
    ],
    render: (a) => {
      const ref = q(a.catalogRef, 'application:<id>');
      const dir = q(a.targetDir, 'src/lib');
      const env = q(a.environment, 'development');
      return [
        `Ship ${ref} with analytics and payments (environment: ${env}).`,
        '',
        `1. swfte_get_context {catalogRef:"${ref}"} — confirm it is the right app and read its evidence.`,
        `2. swfte_wire_analytics {catalogRef:"${ref}", targetDir:"${dir}", environment:"${env}"}. It proposes analytics.enable; relay the approval instructions to the user and wait.`,
        `3. swfte_wire_payments {catalogRef:"${ref}", targetDir:"${dir}", environment:"${env}"} (pass returnUrl/refreshUrl for Stripe onboarding). Same approval flow.`,
        '4. After the user approves in Studio → Actions, call each wire tool again with its actionId; it executes the action and writes the code. A blocked NOT_APPROVED or EXPIRED result is an answer — do not retry around it, and never try to approve on the user\'s behalf.',
        '5. Deploy with swfte_deploy — preview first (the default). Provisioning needs confirm:true and is a human decision, especially for production.',
        '6. Verify: events reach the analytics summary and a test checkout returns a checkoutUrl. Empty analytics is not evidence of health.',
      ].join('\n');
    },
  },
  {
    name: 'bake-into-codebase',
    title: 'Bake a Studio artifact into this codebase',
    description: 'Generate a typed client (or embed) for a catalog artifact and record it in swfte.json.',
    arguments: [
      { name: 'catalogRef', description: '"<kind>:<id>" from swfte_find_existing.', required: true },
      { name: 'language', description: 'typescript | python (default typescript).' },
      { name: 'targetDir', description: 'Directory inside the project (default "src/swfte").' },
    ],
    render: (a) => {
      const ref = q(a.catalogRef, '<kind>:<id>');
      const lang = q(a.language, 'typescript');
      const dir = q(a.targetDir, 'src/swfte');
      return [
        `Bake ${ref} into this codebase (${lang}, ${dir}).`,
        '',
        `1. swfte_get_context {catalogRef:"${ref}"} — read the contract (invoke path, auth, async status path, schemas) and the evidence.`,
        `2. swfte_scaffold_client {catalogRef:"${ref}", language:"${lang}", targetDir:"${dir}"}. It refuses to overwrite existing files; only pass force:true if the user agrees to replace them.`,
        '3. If the contract has an embed, swfte_embed_widget writes it into a page instead.',
        '4. Call the generated function from the code that needs it; keep SWFTE_API_KEY in the real env (never in source). Commit swfte.json so drift against the contract hash is visible later.',
        '5. Run it once end to end and report the result.',
      ].join('\n');
    },
  },
];

export class PromptNotFoundError extends Error {}

export function getPrompt(name: string, args: Record<string, string | undefined> = {}) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw new PromptNotFoundError(`Unknown prompt "${name}". Known: ${PROMPTS.map((x) => x.name).join(', ')}.`);
  const missing = p.arguments.filter((x) => x.required && !(args[x.name] ?? '').trim()).map((x) => x.name);
  if (missing.length) throw new Error(`Prompt "${name}" requires: ${missing.join(', ')}.`);
  return {
    description: p.description,
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.render(args) } }],
  };
}
