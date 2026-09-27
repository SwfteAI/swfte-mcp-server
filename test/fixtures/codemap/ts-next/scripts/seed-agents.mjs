// Warm up the agents after a deploy so the first real visitor does not pay the cold start.
//   node scripts/seed-agents.mjs
import Swfte from '@swfte/sdk';

const client = new Swfte({ apiKey: process.env.SWFTE_API_KEY });

const warmSupport = await client.agents.chat('ag_Supp9x', 'warm-up: reply with OK', { userId: 'deploy-bot' });
console.log('support', warmSupport.response.slice(0, 20));

const PUBLIC_AGENTS = ['ag_Docs2W', 'ag_Pub8Nq'];
for (const id of PUBLIC_AGENTS) {
  const r = await client.agents.chat(id, 'warm-up: reply with OK', { userId: 'deploy-bot' });
  console.log(id, r.response.slice(0, 20));
}
