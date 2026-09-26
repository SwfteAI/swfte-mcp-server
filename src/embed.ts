/**
 * Public agent embed (CONTRACT rev 8b, PROD-PUBLIC-AGENT-CHAT).
 *
 * An agent is put on a web page through `POST /v1/public/agents/{id}/chat`
 * with a publishable embed key (`X-Swfte-Embed-Key: swfte_pk_…`). The key is
 * scoped to that one agent, checked against its origin allow-list and
 * rate-limited, so it is safe in page source — unlike a workspace API key or a
 * PAT, which must never reach a browser. Keys are issued by the agent's owner:
 * `POST /v2/agents/{id}/embed-keys {allowedOrigins}` (shown once).
 *
 * The markup is self-contained (no script from a third-party CDN): a small chat
 * box that keeps a per-browser visitor id, sends `{message, visitorId}` and
 * reads the reply from `content` (falling back to the legacy `response`).
 */
import type { SwfteClient } from './client.js';

export const EMBED_KEY_PATTERN = /^swfte_pk_[A-Za-z0-9_-]{8,}$/;

export function publicAgentChatPath(agentId: string): string {
  return `/v1/public/agents/${encodeURIComponent(agentId)}/chat`;
}

export interface IssuedEmbedKey {
  key: string;
  keyPrefix: string | null;
  allowedOrigins: string[];
}

/** Mint a publishable key for one agent. A mutation: never retried. */
export async function issueEmbedKey(client: SwfteClient, agentId: string, allowedOrigins: string[]): Promise<IssuedEmbedKey> {
  const res = await client.request<Record<string, unknown>>({
    method: 'POST',
    path: `/v2/agents/${encodeURIComponent(agentId)}/embed-keys`,
    body: { allowedOrigins },
    retries: 0,
  });
  const key = typeof res?.key === 'string' ? res.key : '';
  if (!EMBED_KEY_PATTERN.test(key)) {
    // Never write anything that is not a publishable key into a page.
    throw new Error('Swfte did not return a publishable swfte_pk_ embed key, so nothing was written. Issue one in Studio (agent → Embed).');
  }
  return {
    key,
    keyPrefix: typeof res.keyPrefix === 'string' ? res.keyPrefix : null,
    allowedOrigins: Array.isArray(res.allowedOrigins) ? res.allowedOrigins.map(String) : allowedOrigins,
  };
}

/** JSON for inline <script>: `<`, `>` and `&` escaped so no value can close the script element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function htmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function agentEmbedHtml(opts: { agentId: string; name: string; baseUrl: string; embedKey: string; catalogRef: string }): string {
  if (!EMBED_KEY_PATTERN.test(opts.embedKey)) throw new Error('The embed key must be a publishable swfte_pk_ key.');
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}${publicAgentChatPath(opts.agentId)}`;
  const id = `swfte-agent-${opts.agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`;
  const cfg = scriptJson({ endpoint, key: opts.embedKey, root: id, name: opts.name });
  return `<!-- Swfte agent chat: ${htmlText(opts.catalogRef).replace(/--/g, '-')}. Public endpoint + publishable embed key (swfte_pk_, this agent only, origin allow-listed). -->
<div id="${id}" class="swfte-agent-chat" style="font:14px/1.4 system-ui,sans-serif;max-width:420px;border:1px solid #ccc;border-radius:8px;padding:8px">
  <div data-log style="max-height:320px;overflow:auto;margin-bottom:8px" aria-live="polite"></div>
  <form data-form style="display:flex;gap:6px">
    <input data-input name="message" autocomplete="off" required maxlength="4000" placeholder="Ask ${htmlText(opts.name).slice(0, 80)}…" style="flex:1;padding:6px">
    <button type="submit">Send</button>
  </form>
</div>
<script>
(function () {
  var cfg = ${cfg};
  var root = document.getElementById(cfg.root);
  if (!root) return;
  var log = root.querySelector('[data-log]'), form = root.querySelector('[data-form]'), input = root.querySelector('[data-input]');
  var visitor;
  try { visitor = localStorage.getItem('swfte-visitor'); } catch (e) {}
  if (!visitor) {
    visitor = 'v' + Math.random().toString(36).slice(2, 14);
    try { localStorage.setItem('swfte-visitor', visitor); } catch (e) {}
  }
  function add(who, text) {
    var p = document.createElement('p');
    p.style.margin = '4px 0';
    var b = document.createElement('strong');
    b.textContent = who + ': ';
    p.appendChild(b);
    p.appendChild(document.createTextNode(text));
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var message = input.value.trim();
    if (!message) return;
    input.value = '';
    add('You', message);
    fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Swfte-Embed-Key': cfg.key },
      body: JSON.stringify({ message: message, visitorId: visitor })
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      var reply = res.body && (res.body.content != null ? res.body.content : res.body.response);
      add(cfg.name, res.ok && typeof reply === 'string' ? reply : 'Sorry, no answer right now.');
    }).catch(function () { add(cfg.name, 'Sorry, no answer right now.'); });
  });
})();
</script>
`;
}
