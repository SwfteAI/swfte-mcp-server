import { DesignContext, wizardContext } from '../guidance/index.js';
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from './_types.js';
import type { RequestOptions } from '../client.js';
import { AppFrameworkEnum } from '../contracts/backend-options.js';

const BASE = '/v2/app/wizard';
const id = z.string().trim().min(1).max(200).refine(v => v !== '.' && v !== '..', 'Invalid identifier');
const session = z.object({ sessionId: id });
const artifact = z.object({ artifactId: id });
const deployment = z.object({ deploymentId: id });
const enc = encodeURIComponent;
const sessionPath = (i: any) => `${BASE}/${enc(i.sessionId)}`;
const artifactPath = (i: any) => `${BASE}/artifacts/${enc(i.artifactId)}`;
const deploymentPath = (i: any) => `${BASE}/deployments/${enc(i.deploymentId)}`;

function route(name: string, description: string, schema: z.AnyZodObject, method: RequestOptions['method'],
  path: (input: any) => string, body?: (input: any) => unknown, provision = false): ToolDefinition {
  return {
    name: `swfte_app_wizard_${name}`, description, inputSchema: schema,
    ...(method === 'GET' ? { readOnly: true } : {}),
    ...(method === 'DELETE' ? { destructive: true } : {}),
    execute: async (input, { client, config }: ToolContext) => {
      if (provision && (!input.confirm || !config.allowDeploy)) return {
        error: true, refused: true,
        reason: !input.confirm ? 'CONFIRMATION_REQUIRED' : 'DEPLOY_DISABLED',
        message: 'This operation provisions billable capacity; confirm:true and SWFTE_ALLOW_DEPLOY=1 are required.',
      };
      return client.request({ method, path: path(input), body: body?.(input), retries: method === 'GET' ? 1 : 0,
        timeoutMs: method === 'GET' ? 60_000 : 180_000 });
    },
  };
}

// These are hosted AppWizard sessions. The application blueprint adapter remains unchanged.
export const appWizardTools: ToolDefinition[] = [
  route('create', 'Create a hosted AppWizard build session (billable container capacity). Distinct from swfte_build kind application, which creates a blueprint. Poll status; retain sessionId for cleanup. Optional designContext injects referenced cases and explicit product/workflow/agentic guidance.',
    z.object({ name: z.string().trim().min(1).max(200), prompt: z.string().trim().min(10).max(50_000),
      designContext: DesignContext.optional(), description: z.string().max(5000).optional(), mode: z.enum(['HUMAN', 'AGENT']).default('HUMAN'),
      framework: AppFrameworkEnum.default('REACT_VITE'), supervisorModel: z.string().min(1).optional(),
      workspaceRules: z.string().max(50_000).optional(), confirm: z.boolean().default(false) }),
    'POST', () => `${BASE}/create`, ({ confirm, designContext, ...body }) => designContext ? { ...body, prompt: wizardContext(body.prompt, designContext) } : body, true),
  route('prompt', 'Send a follow-up prompt to an existing HUMAN-mode AppWizard session. Do not repeat on timeout; inspect status.',
    session.extend({ prompt: z.string().trim().min(1).max(50_000), designContext: DesignContext.optional() }), 'POST', i => `${sessionPath(i)}/prompt`, i => ({ prompt: i.designContext ? wizardContext(i.prompt, i.designContext) : i.prompt })),
  ...['status', 'plan', 'preview', 'files'].map(action => route(action, `Read AppWizard session ${action}. Status is returned verbatim; a preview URL alone does not prove build completion.`,
    session, 'GET', i => `${sessionPath(i)}/${action}`)),
  route('file', 'Read a generated source file using a relative path.', session.extend({ path: z.string().min(1).max(1000)
    .refine(v => !v.startsWith('/') && !v.includes('\\') && v.split('/').every(p => p && p !== '.' && p !== '..'), 'Use a relative path without traversal') }),
    'GET', i => `${sessionPath(i)}/file/${i.path.split('/').map(enc).join('/')}`),
  ...['complete', 'abort', 'snapshot'].map(action => route(action, `${action === 'complete' ? 'Package and save generated artifacts' : action === 'abort' ? 'Abort an AGENT-mode build' : 'Save a recoverable workspace snapshot'} for an AppWizard session.`,
    session, 'POST', i => `${sessionPath(i)}/${action}`)),
  route('restore', 'Restore an AppWizard session from its saved S3 snapshot; overwrites workspace files.',
    session.extend({ s3Key: z.string().min(1).max(1000) }), 'POST', i => `${sessionPath(i)}/restore`, i => ({ s3Key: i.s3Key })),
  route('destroy', 'Destroy an AppWizard session and its build droplets. Hosted deployments have a separate destroy tool.', session, 'DELETE', sessionPath),
  route('artifacts', 'List saved hosted app artifacts for the authenticated workspace.', z.object({}), 'GET', () => `${BASE}/artifacts`),
  route('artifact_get', 'Read a saved hosted app artifact.', artifact, 'GET', artifactPath),
  route('artifact_download', 'Get a short-lived download URL for a saved hosted app artifact.', artifact, 'GET', i => `${artifactPath(i)}/download`),
  route('artifact_delete', 'Delete a saved hosted app artifact. Stop/destroy its deployed capacity separately.', artifact, 'DELETE', artifactPath),
  route('artifact_fork', 'Fork an existing hosted app artifact into the authenticated workspace.', artifact, 'POST', i => `${artifactPath(i)}/fork`),
  route('deploy', 'Deploy a completed hosted app artifact. Provisions billable capacity; inspect deployment status/logs afterwards.',
    session.extend({ appName: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/), envVars: z.record(z.string()).optional(), confirm: z.boolean().default(false) }),
    'POST', i => `${sessionPath(i)}/deploy`, i => ({ appName: i.appName, envVars: i.envVars }), true),
  route('deployments', 'List hosted app deployments for the authenticated workspace.', z.object({}), 'GET', () => `${BASE}/deployments`),
  route('deployment_get', 'Read hosted app deployment status without assuming readiness.', deployment, 'GET', deploymentPath),
  route('deployment_logs', 'Read hosted app deployment logs.', deployment, 'GET', i => `${deploymentPath(i)}/logs`),
  route('deployment_redeploy', 'Redeploy a hosted app. Provisions billable capacity.', deployment.extend({ confirm: z.boolean().default(false) }),
    'POST', i => `${deploymentPath(i)}/redeploy`, undefined, true),
  route('deployment_stop', 'Stop hosted app runtime capacity. Cleanup remains available when deployment is disabled.', deployment, 'POST', i => `${deploymentPath(i)}/stop`),
  route('deployment_destroy', 'Destroy a hosted app deployment and release its resources.', deployment, 'DELETE', deploymentPath),
];
