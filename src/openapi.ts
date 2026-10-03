import { catalogPath, parseCatalogRef } from './catalog.js';
import type { SwfteClient } from './client.js';

/** The backend derives this document from the same contract as its invoke snippets. */
export interface ArtifactOpenApi {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  'x-swfte-contract-hash'?: string;
  'x-swfte-invoke-unavailable'?: string;
  [key: string]: unknown;
}

export function getOpenApi(client: SwfteClient, ref: string): Promise<ArtifactOpenApi> {
  return client.request<ArtifactOpenApi>({ method: 'GET', path: `${catalogPath(parseCatalogRef(ref))}/openapi` });
}
