import type { SwfteClient } from '../client.js';

export interface ImpactQuery { artifactRef: string; from: string; to: string }
const version = /^[A-Za-z0-9_.:@+-]{1,128}$/;
export function validateImpactQuery(query: ImpactQuery): void {
  if (!/^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9_.@:-]{1,128}$/.test(query.artifactRef)
    || !version.test(query.from) || !version.test(query.to)) throw new Error('Invalid code impact metadata.');
}
export async function codeImpact(client: SwfteClient, query: ImpactQuery): Promise<unknown> {
  validateImpactQuery(query);
  const answer = await client.request<Record<string, unknown>>({ method: 'GET', path: '/v2/codemap/impact', query: { ...query } });
  if (!answer || answer.artifactRef !== query.artifactRef || answer.from !== query.from || answer.to !== query.to
    || !['known', 'unknown'].includes(String(answer.verdict)) || !Array.isArray(answer.breaking)
    || !Array.isArray(answer.cannotCheck) || !Array.isArray(answer.safe) || !Array.isArray(answer.pinned)
    || !Array.isArray(answer.unknownReasons) || (answer.verdict === 'unknown' && answer.unknownReasons.length === 0)) {
    throw new Error('Code impact has no valid measured receipt.');
  }
  return answer;
}
