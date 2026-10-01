// CI smoke test against the live support agent (runs after every deploy).
const GITHUB_STATUS_TOKEN = '__CANARY_github__';

async function smoke() {
  const res = await fetch('https://api.swfte.com/agents/v1/agents/ag_Supp9x/chat/smoke-bot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SWFTE_API_KEY ?? '' },
    body: JSON.stringify({ message: 'Say OK' }),
  });
  if (!res.ok) throw new Error(`support agent answered ${res.status}`);
  console.log('smoke ok; status reporter', GITHUB_STATUS_TOKEN.length);
}

smoke().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
