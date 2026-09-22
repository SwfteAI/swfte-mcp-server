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
      { name: 'framework', description: 'nextjs | express | fastapi | plain-ts | plain-python (default: detected from the project).' },
      { name: 'targetDir', description: 'Directory inside the project for the client (default by framework).' },
    ],
    render: (a) => {
      const ref = q(a.catalogRef, '<kind>:<id>');
      const fw = a.framework?.trim();
      const dir = a.targetDir?.trim();
      const args = [`catalogRef:"${ref}"`, ...(fw ? [`framework:"${fw}"`] : []), ...(dir ? [`targetDir:"${dir}"`] : [])].join(', ');
      return [
        `Bake ${ref} into this codebase${fw ? ` (${fw})` : ' (framework detected from the project)'}.`,
        '',
        `1. swfte_get_context {catalogRef:"${ref}"} — read the contract (invoke path, auth, async status path, schemas), the evidence and who made it and why.`,
        `2. swfte_scaffold_client {${args}}. It writes the typed client, a framework adapter (Next.js route handler / Express router / FastAPI router) and pins the contract in swfte.json. It refuses to overwrite existing files; only pass force:true if the user agrees to replace them.`,
        '3. If the contract has an embed, swfte_embed_widget writes it into a page instead.',
        '4. Put the app\'s auth check in the adapter where marked; keep SWFTE_API_KEY in the real env (never in source). Commit swfte.json and the generated files, and add `npx -p @swfte/mcp-server swfte verify` to CI so contract drift or a pending re-approval fails the build.',
        '5. Run it once end to end and report the result. Later, swfte_sync regenerates clients when contracts move; swfte_check_upgrades is the same check CI runs.',
      ].join('\n');
    },
  },
  {
    name: 'pick-up-tailor-deploy',
    title: 'Pick up a proven solution, tailor it, bake it in, deploy it',
    description:
      'Solution Hub flow: find a proven entry, check its fit for this problem and stack, adopt a tailored copy, bake it ' +
      'into this codebase, and propose an approval-gated deploy.',
    arguments: [
      { name: 'problem', description: 'The problem to solve, in the developer\'s words.', required: true },
      { name: 'kind', description: 'Optional kind to restrict to (workflow, agent, chatflow, widget, application, ...).' },
      { name: 'environment', description: 'development | staging | production (default development).' },
    ],
    render: (a) => {
      const problem = q(a.problem, '(describe the problem)');
      const env = q(a.environment, 'development');
      return [
        `Problem: ${problem}${a.kind ? ` (kind: ${a.kind})` : ''}. Target environment: ${env}.`,
        '',
        'Pick up a proven solution from the Swfte Solution Hub instead of generating one. Steps:',
        `1. Find: swfte_find_existing {query:"${problem.replace(/"/g, "'")}"${a.kind ? `, kinds:["${a.kind}"]` : ''}}. Prefer entries whose evidence rests on independent workspaces; read each one's provenance (author, why) in swfte_get_context before choosing.`,
        '2. Fit: swfte_fit_check {catalogRef, problem} — leave stack out so it is detected from this repo. A weak verdict means try the next candidate or build instead (swfte_solution_advise → swfte_build). Read the gaps.',
        '3. History: swfte_get_timeline {catalogRef} if you need to know who changed it recently and why.',
        '4. Adopt: swfte_adopt {catalogRef, problem, notes?} — copies it into this workspace, tailored. Connect every missingConnections provider with swfte_connect_start (the user signs in), and answer needsInput before running it. The copy starts with no evidence: run it on representative inputs (swfte_run).',
        '5. Bake: swfte_scaffold_client {catalogRef:<the new catalogRef>} — the framework is detected (Next.js route, Express router, FastAPI router, or the plain client). Add the auth check in the adapter, keep SWFTE_API_KEY in the real env, commit swfte.json, and add `npx -p @swfte/mcp-server swfte verify` to CI.',
        `6. Deploy: swfte_request_approval {capability:"workflow.deploy", target:<the new catalogRef>, environment:"${env}"} (or pass deploy:{environment:"${env}"} to swfte_adopt). It is PROPOSED — tell the user to approve it in Studio → Actions. Never execute before approval.`,
        '7. Status: swfte_get_action_status {actionId}; once APPROVED, swfte_execute_approved_action {actionId}. NOT_APPROVED or EXPIRED is an answer, not something to retry around.',
        'Report which entry you picked and why (fit verdict, evidence, provenance), what was tailored, what the user must still connect or approve, and the files written.',
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
