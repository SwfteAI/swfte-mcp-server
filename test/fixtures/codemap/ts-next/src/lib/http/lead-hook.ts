// CRM webhook relay: every new CRM contact is sent to the lead-enrich workflow.
const HOST = 'https://api.swfte.com';

export async function relayCrmContact(contact: { email: string; company?: string }): Promise<number> {
  const url = new URL('/agents/v2/workflows/wf_Lead5Q/invoke', HOST);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SWFTE_API_KEY ?? '' },
    body: JSON.stringify(contact),
  });
  return res.status;
}
