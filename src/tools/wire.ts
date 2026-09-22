/**
 * Wiring tools: connect a customer app to Swfte analytics and payments.
 *
 * Both follow the same two-phase shape. The platform-side change (minting an
 * app key, enabling payments) is an approval-gated action; the tool proposes
 * it, stops with approval instructions, and — called again with the actionId
 * once a human has approved — executes it and writes the code-side half into
 * the project. Code never carries a credential: the analytics key is
 * publishable and lives in an env file; the payments runtime token is secret
 * and is never written or echoed at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { SwfteClient } from '../client.js';
import { CatalogRefArg, ENVIRONMENTS, parseCatalogRef, searchCatalog, type ActionCapability } from '../catalog.js';
import { executeAction, getAction, presentAction, proposeAction, type ActionRequest } from '../actions.js';
import { ConfinedWriter, INLINE_NOTE, gitignoreCovers } from '../fsguard.js';
import type { ToolDefinition } from './_types.js';

const FRAMEWORKS = ['next', 'react', 'browser', 'node'] as const;
type Framework = (typeof FRAMEWORKS)[number];

/** Resolve the application an action targets, from a catalogRef or an exact application name. */
async function resolveApplication(client: SwfteClient, input: { catalogRef?: string; appName?: string }) {
  if (input.catalogRef) {
    const r = parseCatalogRef(input.catalogRef);
    if (r.kind !== 'application') throw new Error(`${r.ref} is a ${r.kind}; this wiring applies to applications ("application:<id>").`);
    return { kind: 'application', id: r.id, name: undefined as string | undefined };
  }
  if (!input.appName) throw new Error('Pass catalogRef ("application:<id>") or appName.');
  const res = await searchCatalog(client, { query: input.appName, kinds: ['application'], scope: 'workspace', limit: 20 });
  const exact = res.items.filter((i) => i.name?.trim().toLowerCase() === input.appName!.trim().toLowerCase());
  if (exact.length === 1) return { kind: 'application', id: exact[0]!.id, name: exact[0]!.name };
  const candidates = (exact.length ? exact : res.items).map((i) => `${i.catalogRef ?? `application:${i.id}`} (${i.name})`);
  throw new Error(
    exact.length > 1
      ? `appName "${input.appName}" matches ${exact.length} applications: ${candidates.join(', ')}. Pass catalogRef instead.`
      : `No application named "${input.appName}" in this workspace.${candidates.length ? ` Close matches: ${candidates.join(', ')}.` : ''} Pass catalogRef, or create the application in Studio first.`
  );
}

/**
 * Take an action as far as policy allows without a human: propose it (or load
 * the one named), execute it when approved or when no approval is required.
 */
async function advance(
  client: SwfteClient,
  opts: { capability: ActionCapability; target: { kind: string; id: string }; params?: Record<string, unknown>; environment: string; actionId?: string }
): Promise<{ action: ActionRequest; blocked?: Record<string, unknown> }> {
  let action: ActionRequest;
  if (opts.actionId) {
    action = await getAction(client, opts.actionId);
    if (action.capability !== opts.capability || action.target?.kind !== opts.target.kind || action.target?.id !== opts.target.id) {
      throw new Error(
        `Action ${opts.actionId} is ${action.capability} on ${action.target?.kind}:${action.target?.id}, not ` +
          `${opts.capability} on ${opts.target.kind}:${opts.target.id}. Pass the actionId this tool returned for this app.`
      );
    }
  } else {
    action = await proposeAction(client, opts);
  }
  if (action.status === 'APPROVED' || (action.status === 'PROPOSED' && action.requiresApproval === false)) {
    const outcome = await executeAction(client, action.id);
    if (!outcome.executed) {
      const { action: current, ...rest } = outcome;
      return { action: current ?? action, blocked: rest };
    }
    action = outcome.action;
  }
  return { action };
}

function pending(tool: string, action: ActionRequest, blocked?: Record<string, unknown>) {
  const p = presentAction(action);
  return {
    wired: false,
    stage: action.status === 'PROPOSED' ? 'AWAITING_APPROVAL' : action.status,
    ...(blocked ? { blocked } : {}),
    action: p,
    nextStep:
      action.status === 'PROPOSED' || action.status === 'APPROVED'
        ? `${p.instructions} Or call ${tool} again with actionId:"${action.id}" — it executes the approved action and writes the code.`
        : p.instructions,
    filesWritten: [],
  };
}

/** An http(s) URL with nothing that could break an env line or a string, else undefined. */
function safeHttpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || /[\s"'`#\\$]/.test(v)) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : undefined;
  } catch {
    return undefined;
  }
}

function detectFramework(root: string): Framework {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.next) return 'next';
    if (deps.react) return 'react';
    return existsSync(join(root, 'index.html')) ? 'browser' : 'node';
  } catch {
    return 'browser';
  }
}

export function analyticsSnippet(framework: Framework, appId: string, defaultEndpoint: string): { file: string; content: string } {
  const header =
    '// Generated by @swfte/mcp-server (swfte_wire_analytics).\n' +
    '// The app key is publishable (swfte_pk_…) and read from the environment; never put a secret (sk-/pat_) here.\n';
  const id = JSON.stringify(appId);
  const ep = JSON.stringify(defaultEndpoint);
  switch (framework) {
    case 'next':
      return {
        file: 'swfte-analytics.tsx',
        content:
          `'use client';\n${header}import type { ReactNode } from 'react';\nimport { AnalyticsProvider } from '@swfte/analytics/react';\n\n` +
          `export const swfteAnalyticsConfig = {\n  appId: ${id},\n  appKey: process.env.NEXT_PUBLIC_SWFTE_ANALYTICS_APP_KEY,\n` +
          `  endpoint: process.env.NEXT_PUBLIC_SWFTE_ANALYTICS_ENDPOINT ?? ${ep},\n};\n\n` +
          `/** Wrap the root layout's children: <SwfteAnalytics>{children}</SwfteAnalytics>. */\n` +
          `export function SwfteAnalytics({ children }: { children: ReactNode }) {\n  return <AnalyticsProvider config={swfteAnalyticsConfig}>{children}</AnalyticsProvider>;\n}\n`,
      };
    case 'react':
      return {
        file: 'swfte-analytics.tsx',
        content:
          `${header}// Expose SWFTE_ANALYTICS_APP_KEY to the client bundle (e.g. Vite \`define\`, CRA REACT_APP_ alias).\n` +
          `import type { ReactNode } from 'react';\nimport { AnalyticsProvider } from '@swfte/analytics/react';\n\n` +
          `const env = (globalThis as any).process?.env ?? {};\n\n` +
          `export const swfteAnalyticsConfig = {\n  appId: ${id},\n  appKey: env.SWFTE_ANALYTICS_APP_KEY as string | undefined,\n` +
          `  endpoint: (env.SWFTE_ANALYTICS_ENDPOINT as string | undefined) ?? ${ep},\n};\n\n` +
          `export function SwfteAnalytics({ children }: { children: ReactNode }) {\n  return <AnalyticsProvider config={swfteAnalyticsConfig}>{children}</AnalyticsProvider>;\n}\n`,
      };
    case 'node':
      return {
        file: 'swfte-analytics.ts',
        content:
          `${header}import { ServerAnalytics } from '@swfte/analytics/server';\n\n` +
          `export const analytics = new ServerAnalytics({\n  appId: ${id},\n  appKey: process.env.SWFTE_ANALYTICS_APP_KEY,\n` +
          `  endpoint: process.env.SWFTE_ANALYTICS_ENDPOINT ?? ${ep},\n});\n`,
      };
    default:
      return {
        file: 'swfte-analytics.ts',
        content:
          `${header}// Expose SWFTE_ANALYTICS_APP_KEY to the client bundle through your bundler's env mechanism.\n` +
          `import { init } from '@swfte/analytics';\n\nconst env = (globalThis as any).process?.env ?? {};\n\n` +
          `export const analytics = init({\n  appId: ${id},\n  appKey: env.SWFTE_ANALYTICS_APP_KEY,\n  endpoint: env.SWFTE_ANALYTICS_ENDPOINT ?? ${ep},\n});\n\nanalytics.page();\n`,
      };
  }
}

export function checkoutHelper(defaultBaseUrl: string): string {
  return `// Generated by @swfte/mcp-server (swfte_wire_payments). SERVER-SIDE ONLY.
// Creates a Stripe checkout session through Swfte's app runtime. The runtime token is a
// secret: it is read from SWFTE_APP_RUNTIME_TOKEN and must never reach browser code.

export interface CheckoutLineItem {
  name: string;
  /** Integer amount in the smallest currency unit (e.g. cents). */
  amountCents: number;
  /** ISO currency code, e.g. "usd". */
  currency: string;
  quantity: number;
}

export interface CheckoutSessionRequest {
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(req: CheckoutSessionRequest): Promise<{ checkoutUrl: string }> {
  if (typeof (globalThis as any).window !== 'undefined') {
    throw new Error('createCheckoutSession is server-only: it uses SWFTE_APP_RUNTIME_TOKEN.');
  }
  const env = (globalThis as any).process?.env ?? {};
  const token: string | undefined = env.SWFTE_APP_RUNTIME_TOKEN;
  if (!token) throw new Error('SWFTE_APP_RUNTIME_TOKEN is not set (see .env.example).');
  if (!req.lineItems?.length) throw new Error('At least one line item is required.');
  for (const item of req.lineItems) {
    if (!Number.isInteger(item.amountCents) || item.amountCents <= 0) throw new Error(\`Invalid amountCents for "\${item.name}".\`);
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error(\`Invalid quantity for "\${item.name}".\`);
  }
  const baseUrl = String(env.SWFTE_BASE_URL ?? ${JSON.stringify(defaultBaseUrl)}).replace(/\\/+$/, '');
  const res = await fetch(\`\${baseUrl}/v2/app-runtime/payments/checkout-session\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-App-Runtime-Token': token },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(\`Checkout session failed: \${res.status} \${text.slice(0, 300)}\`);
  const body = JSON.parse(text) as { checkoutUrl?: string };
  if (!body.checkoutUrl) throw new Error('Checkout session response carried no checkoutUrl.');
  return { checkoutUrl: body.checkoutUrl };
}
`;
}

const Common = {
  targetDir: z.string().min(1).describe('Directory inside the project to write into (e.g. "src/lib"). Created if missing.'),
  environment: z.enum(ENVIRONMENTS).optional().describe('Default "development".'),
  actionId: z.string().optional().describe('The actionId a previous call returned; pass it once a human has approved.'),
  force: z.boolean().optional().describe('Replace an existing generated file whose content differs. Default false.'),
};

export const wireTools: ToolDefinition[] = [
  {
    name: 'swfte_wire_analytics',
    title: 'Wire Swfte analytics into an app',
    description:
      'Connect an application\'s code to Swfte analytics. Phase 1 proposes the approval-gated action ' +
      'analytics.enable and returns approval instructions. Phase 2 (call again with actionId after a human ' +
      'approves) executes it to mint a publishable app key (swfte_pk_…) and writes an @swfte/analytics init ' +
      'module for the framework (next | react | browser | node; auto-detected from package.json) plus ' +
      'SWFTE_ANALYTICS_APP_KEY in the env files — all confined under the working directory, never overwriting ' +
      'without force. Refuses to write any key that is not publishable.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg.optional().describe('"application:<id>" of the app.'),
      appName: z.string().optional().describe('Exact application name, when you do not have its catalogRef.'),
      framework: z.enum(FRAMEWORKS).optional(),
      ...Common,
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const writer = new ConfinedWriter({ forbidden: [config.credential], inline: localFilesystem === false });
      const dir = writer.resolve(input.targetDir);
      const app = await resolveApplication(client, input);
      const environment = input.environment ?? 'development';
      const { action, blocked } = await advance(client, {
        capability: 'analytics.enable',
        target: { kind: 'application', id: app.id },
        environment,
        actionId: input.actionId,
      });
      if (blocked || action.status !== 'EXECUTED') return pending('swfte_wire_analytics', action, blocked);

      const result = (action.result ?? {}) as Record<string, unknown>;
      const appKey = String(result.appKey ?? result.key ?? '');
      if (!appKey) {
        return { wired: false, stage: 'EXECUTED_WITHOUT_KEY', action: presentAction(action), nextStep: 'The action executed but returned no appKey. Create one in Studio → Application → Analytics and set SWFTE_ANALYTICS_APP_KEY yourself.', filesWritten: [] };
      }
      if (!/^swfte_pk_[A-Za-z0-9_-]+$/.test(appKey)) {
        return { wired: false, stage: 'REFUSED_NON_PUBLISHABLE_KEY', action: presentAction(action), nextStep: 'The returned key is not a publishable swfte_pk_ key, so it was not written anywhere. Check the application\'s analytics keys in Studio.', filesWritten: [] };
      }
      const appId = String(result.appId ?? app.id);
      const endpoint = safeHttpUrl(result.endpoint ?? result.ingestEndpoint) ?? `${config.baseUrl}/v1/analytics/web/ingest`;
      const framework = input.framework ?? (writer.inline ? 'browser' : detectFramework(writer.root));
      const snippet = analyticsSnippet(framework, appId, endpoint);
      writer.create(writer.resolve(`${dir}/${snippet.file}`), snippet.content, input.force);

      const envFile = framework === 'next' ? '.env.local' : '.env';
      const real = [
        { key: 'SWFTE_ANALYTICS_APP_KEY', value: appKey, comment: 'Publishable Swfte analytics key (safe for browsers).' },
        { key: 'SWFTE_ANALYTICS_ENDPOINT', value: endpoint },
        ...(framework === 'next'
          ? [
              { key: 'NEXT_PUBLIC_SWFTE_ANALYTICS_APP_KEY', value: appKey },
              { key: 'NEXT_PUBLIC_SWFTE_ANALYTICS_ENDPOINT', value: endpoint },
            ]
          : []),
      ];
      const envResult = writer.mergeEnv(writer.resolve(envFile), real, { force: input.force, header: 'Swfte analytics (swfte_wire_analytics)' });
      writer.mergeEnv(
        writer.resolve('.env.example'),
        real.map((e) => ({ key: e.key, value: '', comment: e.comment })),
        { header: 'Swfte analytics (swfte_wire_analytics)' }
      );
      const written = writer.commit();
      return {
        wired: true,
        application: { catalogRef: `application:${app.id}`, appId },
        framework,
        endpoint,
        action: presentAction(action),
        filesWritten: written,
        env: envResult,
        ...(writer.inline
          ? { inline: true, note: INLINE_NOTE }
          : {}),
        ...(writer.inline || gitignoreCovers(writer.root, envFile) ? {} : { warning: `${envFile} does not appear in .gitignore. The analytics key is publishable, but keep env files out of git by habit.` }),
        nextSteps: [
          framework === 'next' || framework === 'react'
            ? `Wrap your root component with <SwfteAnalytics> from ./${snippet.file.replace(/\.tsx$/, '')}.`
            : `Import ./${snippet.file.replace(/\.ts$/, '')} once at startup.`,
          'Install the SDK: npm install @swfte/analytics.',
          'Verify events arrive: GET /v2/applications/{id}/analytics/summary?days=7 in Studio (empty analytics is not proof of health).',
        ],
      };
    },
  },
  {
    name: 'swfte_wire_payments',
    title: 'Wire Swfte payments into an app',
    description:
      'Enable payments for a Studio application and write a server-side checkout helper. Phase 1 proposes the ' +
      'approval-gated action app.payments.enable; phase 2 (call again with actionId after approval) executes it ' +
      'and writes swfte-checkout.ts, which calls POST /v2/app-runtime/payments/checkout-session with the ' +
      'X-App-Runtime-Token header read from SWFTE_APP_RUNTIME_TOKEN, plus that variable in .env.example. The ' +
      'runtime token is never written or echoed. Production enablement is an explicit human decision; deploy ' +
      'stays with swfte_deploy (preview by default).',
    inputSchema: z.object({
      catalogRef: CatalogRefArg.describe('"application:<id>" of the app.'),
      returnUrl: z.string().url().optional().describe('Where Stripe onboarding returns after completion.'),
      refreshUrl: z.string().url().optional().describe('Where Stripe onboarding sends the user if its link expires.'),
      ...Common,
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const writer = new ConfinedWriter({ forbidden: [config.credential], inline: localFilesystem === false });
      const dir = writer.resolve(input.targetDir);
      const app = await resolveApplication(client, { catalogRef: input.catalogRef });
      const params: Record<string, unknown> = {};
      if (input.returnUrl) params.returnUrl = input.returnUrl;
      if (input.refreshUrl) params.refreshUrl = input.refreshUrl;
      const { action, blocked } = await advance(client, {
        capability: 'app.payments.enable',
        target: { kind: 'application', id: app.id },
        params,
        environment: input.environment ?? 'development',
        actionId: input.actionId,
      });
      if (blocked || action.status !== 'EXECUTED') return pending('swfte_wire_payments', action, blocked);

      writer.create(writer.resolve(`${dir}/swfte-checkout.ts`), checkoutHelper(config.baseUrl), input.force);
      writer.mergeEnv(
        writer.resolve('.env.example'),
        [
          { key: 'SWFTE_APP_RUNTIME_TOKEN', value: '', comment: 'Secret app-runtime token from Studio → Application → Payments. Server-side only; never commit it.' },
          { key: 'SWFTE_BASE_URL', value: '' },
        ],
        { header: 'Swfte payments (swfte_wire_payments)' }
      );
      const written = writer.commit();
      const result = (action.result ?? {}) as Record<string, unknown>;
      const onboardingUrl = typeof result.onboardingUrl === 'string' ? result.onboardingUrl : typeof result.url === 'string' ? result.url : null;
      return {
        wired: true,
        application: { catalogRef: `application:${app.id}` },
        action: presentAction(action),
        filesWritten: written,
        ...(writer.inline ? { inline: true, note: INLINE_NOTE } : {}),
        ...(onboardingUrl ? { onboardingUrl } : {}),
        nextSteps: [
          ...(onboardingUrl ? [`Have the account owner finish Stripe onboarding: ${onboardingUrl}`] : []),
          'Set SWFTE_APP_RUNTIME_TOKEN in the server environment from Studio (it is deliberately not written here).',
          'Call createCheckoutSession from a server route and redirect the browser to checkoutUrl.',
          'Ship it with swfte_deploy (preview by default; provisioning needs confirm and an approved workflow.deploy / app.host action).',
        ],
      };
    },
  },
];
