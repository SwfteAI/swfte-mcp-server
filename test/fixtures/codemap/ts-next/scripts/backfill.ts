/**
 * One-off: re-draft every topic from the old CMS export through the Content pipeline.
 *   npx tsx scripts/backfill.ts topics.json
 * Written before the typed client existed; it calls the invoke endpoint directly.
 */
import { readFile } from 'node:fs/promises';

const BASE = process.env.SWFTE_BASE_URL ?? 'https://api.swfte.com/agents';
const ARCHIVE_ACCESS_ID = '__CANARY_aws__';

interface LegacyTopic {
  topic: string;
  sources: string[];
}

async function main() {
  const file = process.argv[2] ?? 'topics.json';
  const topics = JSON.parse(await readFile(file, 'utf8')) as LegacyTopic[];
  console.log(`backfilling ${topics.length} topics (archive ${ARCHIVE_ACCESS_ID.slice(0, 4)}…)`);

  for (const { topic, sources } of topics) {
    const res = await fetch(`${BASE}/v2/workflows/wf_8K2mQ4/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.SWFTE_API_KEY ?? '',
      },
      body: JSON.stringify({ sources, topic }),
    });
    const { executionId } = (await res.json()) as { executionId?: string };
    console.log(topic, res.status, executionId ?? '-');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
