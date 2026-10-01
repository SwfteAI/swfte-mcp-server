// Deploy hook: warm the SEO audit cache for the home page right after a release.
//   npx tsx scripts/warm-cache.ts
import { Swfte } from '@swfte/sdk';

const client = new Swfte({ apiKey: process.env.SWFTE_API_KEY ?? '__CANARY_swfte__' });

const warm = await client.workflows.invoke('wf_Seo3Pz', { url: 'https://acme.test/', depth: 0 });
console.log('warming', warm.executionId);
