import { z } from 'zod';
import tourData from '../guidance/tour-sandbox-first.json';
import type { ToolDefinition } from './_types.js';

/**
 * swfte_tour: a deep link into Studio's in-product Sandbox-first tour, plus the step table with
 * the MCP call that does the same thing. Local data only: no backend call, no side effects.
 *
 * The link format mirrors Studio's walkthrough/deep-link.ts: `?tour=<track>&step=<id>`. An
 * unknown track is ignored by Studio (so we refuse it here instead of handing out a dead link);
 * a known track with an unknown step starts at step 1 (so we still return the link, with a warning).
 */

export const TOUR_TRACK_DEFAULT = 'sandbox-first';
const TRACKS: Record<string, typeof tourData> = { [tourData.track]: tourData };

export interface TourStep {
  id: string;
  chapter: number;
  chapterTitle: string;
  title: string;
  route: string | null;
  enterprise: boolean;
  mcp: { tool: string; args: Record<string, unknown>; prompt: string } | null;
}

export function studioBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SWFTE_STUDIO_URL?.trim() || 'https://studio.swfte.com').replace(/\/+$/, '');
}

/** `<base>/v2/studio/welcome?tour=<track>[&step=<id>][&id=<workflowId>]`. */
export function buildTourLink(base: string, track: string, step?: string, workflowId?: string): string {
  const params = new URLSearchParams({ tour: track });
  if (step) params.set('step', step);
  if (workflowId) params.set('id', workflowId);
  return `${base}/v2/studio/welcome?${params.toString()}`;
}

export const tourTools: ToolDefinition[] = [
  {
    name: 'swfte_tour',
    title: 'Studio Sandbox-first tour link and steps',
    group: 'core',
    readOnly: true,
    description:
      'Get a deep link into the Studio in-product tour of Sandbox-first (build in a Sandbox, prove, promote) ' +
      'plus the list of tour steps, each with the MCP tool call that does the same thing. Read-only; calls no backend. ' +
      'Hand the link to the user ("open this to see it"), or walk them through by calling the listed tools yourself. ' +
      'Pass `step` (a step id from the list) to jump to one step; `workflowId` to open the tour on a specific workflow.',
    inputSchema: z.object({
      track: z.string().optional().describe("Tour track. Only 'sandbox-first' exists (default)."),
      step: z.string().optional().describe('Step id from the returned list. Omit to start at step 1.'),
      workflowId: z.string().optional().describe('Workflow to open the tour on; fills <workflowId> in the step args.'),
    }),
    execute: async (input) => {
      const track = input.track ?? TOUR_TRACK_DEFAULT;
      const data = TRACKS[track];
      if (!data) {
        throw new Error(`Unknown tour track "${track}". Available: ${Object.keys(TRACKS).join(', ')}.`);
      }
      const rawSteps = data.steps as TourStep[];
      // With a workflowId, fill the <workflowId> placeholder so the args are ready to call.
      const steps: TourStep[] = input.workflowId
        ? (JSON.parse(JSON.stringify(rawSteps).split('<workflowId>').join(JSON.stringify(input.workflowId).slice(1, -1))) as TourStep[])
        : rawSteps;
      const warnings: string[] = [];
      if (input.step && !steps.some((s) => s.id === input.step)) {
        warnings.push(
          `Unknown step "${input.step}": Studio will start the tour at step 1. Valid ids: ${steps.map((s) => s.id).join(', ')}.`,
        );
      }
      return {
        track,
        title: data.title,
        summary: data.summary,
        link: buildTourLink(studioBaseUrl(), track, input.step, input.workflowId),
        ...(warnings.length ? { warnings } : {}),
        howToUse:
          'Either give the user the link to open in Studio, or walk them through the tour yourself by calling each step\'s `mcp.tool` ' +
          'with its `mcp.args` (replace <placeholders> such as <workflowId> and <sessionId> with real values).',
        steps,
      };
    },
  },
];
