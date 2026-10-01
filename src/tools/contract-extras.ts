import { z } from 'zod';
import { CatalogRefArg } from '../catalog.js';
import { getOpenApi } from '../openapi.js';
import type { ToolDefinition } from './_types.js';

export const contractExtraTools: ToolDefinition[] = [{
  name: 'swfte_get_openapi',
  title: 'Read an artifact OpenAPI contract',
  description: 'Read the backend-derived OpenAPI 3.1 document for a catalog ref. It shares the invoke contract hash. Empty paths mean invocation is unavailable; never invent an endpoint from the artifact ID.',
  readOnly: true,
  inputSchema: z.object({ ref: CatalogRefArg }),
  execute: (input, { client }) => getOpenApi(client, input.ref),
}];
