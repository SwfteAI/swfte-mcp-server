// The kiosk build cannot use the SDK (it targets an old runtime), so it opens chatflow sessions by hand.
const base = process.env.SWFTE_BASE_URL;

export async function openKioskSession(kioskId: string): Promise<string> {
  const res = await fetch(`${base}/v2/chatflows/cf_Onb7Rz/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SWFTE_API_KEY ?? '' },
    body: JSON.stringify({ channel: 'kiosk', metadata: { kioskId } }),
  });
  const session = (await res.json()) as { id: string };
  return session.id;
}
