// GET /api/embed — an HTML fragment partner sites drop into their help pages.
export async function GET(): Promise<Response> {
  const html = `<div class="acme-help">
  <iframe src="https://app.swfte.com/chat/ag_Docs2W" title="Acme docs assistant" width="400" height="600" loading="lazy"></iframe>
</div>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
