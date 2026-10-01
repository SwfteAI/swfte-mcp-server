import Swfte from '@swfte/sdk';

/** One SDK client per server process. Server-only: the key never reaches the browser. */
export const swfte = new Swfte({
  apiKey: process.env.SWFTE_API_KEY ?? '',
  workspaceId: process.env.SWFTE_WORKSPACE_ID ?? '__CANARY_default__',
  timeout: 30_000,
});
