/** HTML-template widget detector (docs/codemap/CONTRACT.md §7): used for every language's templates. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DETECTORS } from '../src/codemap/detectors/html/index.js';
import { detectProject } from '../src/codemap/detect.js';
import { DEFAULT_ENV_FILES } from '../src/codemap/walk.js';
import type { DetectedSite } from '../src/codemap/types.js';

const FIX = new URL('./fixtures/codemap/', import.meta.url).pathname;
const ENV_FILES = { secret: [...DEFAULT_ENV_FILES.secret, 'dot-env', 'dot-env.*'], names: [...DEFAULT_ENV_FILES.names, 'dot-env.example'] };

function run(text: string, relPath = 'public/x.html'): DetectedSite[] {
  const out: DetectedSite[] = [];
  for (const d of DETECTORS) out.push(...d.detect({ relPath, language: 'html', text }, { locks: [], lockDir: null }).sites);
  return out;
}

describe('html widget detector', () => {
  test('iframe src to a hosted chat page is a widget site on the iframe line', () => {
    const s = run('<html>\n<body>\n  <iframe\n    src="https://app.swfte.com/chat/ag_1"\n    title="x"></iframe>\n</body>\n</html>\n');
    assert.equal(s.length, 1);
    assert.deepEqual([s[0]!.line, s[0]!.artifact.kind, s[0]!.artifact.id, s[0]!.category, s[0]!.sdk, s[0]!.op, s[0]!.managed, s[0]!.symbol, s[0]!.language], [3, 'agent', 'ag_1', 'widget', 'widget-embed', 'embed', 'typed-client', '<module>', 'html']);
  });

  test('the loader script src is never a site; inline new SwfteChatWidget is', () => {
    const s = run('<script src="https://unpkg.com/@swfte/chat-widget@1.4.0/dist/swfte-chat.umd.js"></script>\n<div></div>\n<script>\n  const w = new SwfteChatWidget({\n    agentId: \'ag_2\',\n  });\n  w.mount();\n</script>\n');
    assert.deepEqual(s.map((x) => [x.line, x.artifact.id]), [[4, 'ag_2']]);
  });

  test('template placeholder in the id position is unresolved', () => {
    const a = run("<iframe src=\"https://app.swfte.com/chat/{{ agent_id }}\"></iframe>\n");
    assert.deepEqual([a.length, a[0]!.artifact.id, a[0]!.artifact.unresolved, a[0]!.category], [1, null, true, 'dynamic']);
    const b = run("<script>new SwfteChatWidget({ agentId: '{{ agent_id }}', type: 'bubble' }).mount();</script>\n");
    assert.deepEqual([b.length, b[0]!.artifact.unresolved], [1, true]);
  });

  test('HTML comments never count', () => {
    assert.equal(run('<!-- <iframe src="https://app.swfte.com/chat/ag_c"></iframe> -->\n<!--\n<script>new SwfteChatWidget({ agentId: \'ag_c\' })</script>\n-->\n').length, 0);
  });

  test('inline config naming the public agent endpoint is one site at the config line', () => {
    const s = run('<script>\n(function () {\n  var cfg = {"endpoint":"https://api.swfte.com/agents/v1/public/agents/ag_Pub/chat","key":"swfte_pk_x"};\n  fetch(cfg.endpoint, {});\n})();\n</script>\n');
    assert.deepEqual(s.map((x) => [x.line, x.artifact.id]), [[3, 'ag_Pub']]);
  });

  test('Jinja comments never count', () => {
    assert.equal(run('{# <iframe src="https://app.swfte.com/chat/ag_c"></iframe> #}\n{% comment %}<iframe src="https://app.swfte.com/chat/ag_d"></iframe>{% endcomment %}\n').length, 0);
  });

  test('Thymeleaf: th:src expression and an inline expression with a prototype fallback are unresolved', () => {
    const s = run('<script th:inline="javascript">\nnew SwfteChatWidget({\n  agentId: /*[[${agent}]]*/ \'ag_Proto\',\n});\n</script>\n<iframe th:src="@{https://app.swfte.com/chat/{id}(id=${agent})}"></iframe>\n');
    assert.deepEqual(s.map((x) => [x.line, x.artifact.id, x.artifact.unresolved]), [[2, null, true], [6, null, true]]);
  });

  test('iframes to other hosts and scripts that only mention the widget are ignored', () => {
    assert.equal(run('<iframe src="https://example.com/chat/ag_1"></iframe>\n<script>console.log("SwfteChatWidget");</script>\n').length, 0);
  });

  test('a locally defined SwfteChatWidget is not the Swfte widget', () => {
    assert.equal(run("<script>function SwfteChatWidget(c) {}\nnew SwfteChatWidget({ agentId: 'ag_1' });</script>\n").length, 0);
  });

  test('a test template is not scanned', () => {
    assert.equal(run('<iframe src="https://app.swfte.com/chat/ag_1"></iframe>\n', 'tests/page.html').length, 0);
  });

  test('corpus: ts-next public pages and python/monorepo templates match the labelled lines', async () => {
    const tsn = await detectProject(`${FIX}ts-next`, { envFiles: ENV_FILES });
    const html = tsn.sites.filter((s) => s.language === 'html').map((s) => [s.relPath, s.line, s.artifact.id]);
    assert.deepEqual(html, [['public/agent-embed.html', 19, 'ag_Pub8Nq'], ['public/embed.html', 11, 'ag_Docs2W'], ['public/support-frame.html', 13, 'ag_Supp9x']]);
    const mono = await detectProject(`${FIX}monorepo`, { envFiles: ENV_FILES });
    const m = mono.sites.filter((s) => s.language === 'html').map((s) => [s.relPath, s.line, s.artifact.id]);
    assert.deepEqual(m, [['packages/admin/src/views/help.html', 10, 'ag_Docs2W'], ['packages/web/public/widget.html', 5, 'ag_Supp9x'], ['py/worker/acme_worker/templates/help.html', 9, 'ag_Supp9x'], ['py/worker/acme_worker/templates/help.html', 11, null]]);
  });
});
