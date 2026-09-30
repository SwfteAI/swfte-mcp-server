/**
 * Java code map detectors (docs/codemap/CONTRACT.md §2, §2.1, §7; FIXTURES.md §4.1): Swfte SDK call sites,
 * raw HTTP (RestTemplate, WebClient, java.net.http), widget text blocks, dynamic ids from `@Value` and
 * `System.getenv`, keys, decoys, broken files. The corpus tests compare every answer-key site of java-spring
 * (and the Java part of the monorepo) by (path, line, artifact, inputKeys, outputKeys); keys are only read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectProject } from '../src/codemap/detect.js';
import { DETECTORS as JAVA } from '../src/codemap/detectors/java/index.js';
import { initJavaParser } from '../src/codemap/detectors/java/parse.js';
import { DEFAULT_ENV_FILES } from '../src/codemap/walk.js';
import type { DetectContext, DetectedSite } from '../src/codemap/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'fixtures', 'codemap');
const ENV_FILES = { secret: [...DEFAULT_ENV_FILES.secret, 'dot-env', 'dot-env.*'], names: [...DEFAULT_ENV_FILES.names, 'dot-env.example'] };
const NO_LOCKS: DetectContext = { locks: [], lockDir: null };

function run(text: string, relPath = 'src/main/java/com/acme/Svc.java'): { sites: DetectedSite[]; envVarNames: string[] } {
  const out: { sites: DetectedSite[]; envVarNames: string[] } = { sites: [], envVarNames: [] };
  for (const d of JAVA) {
    const r = d.detect({ relPath, language: 'java', text }, NO_LOCKS);
    out.sites.push(...r.sites);
    out.envVarNames.push(...r.envVarNames);
  }
  out.sites.sort((a, b) => a.line - b.line);
  return out;
}

/** A class wrapper with the SDK import and a `client` field, so bodies stay short. */
const cls = (body: string, extraImports = ''): string =>
  ['package com.acme;', 'import com.swfte.sdk.SwfteClient;', 'import java.util.*;', extraImports, 'public class Svc {', '  private final SwfteClient client = null;', body, '}', ''].join('\n');

describe('java managed SDK calls', () => {
  test('SDK ops: run, chat, read-output; SDK sites have no alias and sdk java', () => {
    const src = cls(
      [
        '  public void go() {',
        '    client.workflows().invokeAndWait("wf_A", Map.of("x", 1));',
        '    client.agents().chat("ag_B", "hello");',
        '    client.workflows().getExecutionHistory("wf_A");',
        '    client.chatflows().startSession("cf_C", null);',
        '  }',
      ].join('\n'),
    );
    const r = run(src);
    assert.deepEqual(
      r.sites.map((s) => [s.line, s.op, s.artifact.kind, s.artifact.id, s.artifact.alias, s.sdk, s.managed, s.language, s.detector]),
      [
        [8, 'run', 'workflow', 'wf_A', null, 'java', 'typed-client', 'java', 'java.managed'],
        [9, 'chat', 'agent', 'ag_B', null, 'java', 'typed-client', 'java', 'java.managed'],
        [10, 'read-output', 'workflow', 'wf_A', null, 'java', 'typed-client', 'java', 'java.managed'],
        [11, 'chat', 'chatflow', 'cf_C', null, 'java', 'typed-client', 'java', 'java.managed'],
      ],
    );
    assert.deepEqual(r.sites[2]!.inputKeys, []);
    assert.deepEqual(r.sites[2]!.outputKeys, []);
  });

  test('a static final constant in the same file resolves the id', () => {
    const src = cls('  private static final String WF = "wf_Const";\n  void f() { client.workflows().invoke(WF, Map.of("a", 1)); }');
    const r = run(src);
    assert.equal(r.sites.length, 1);
    assert.equal(r.sites[0]!.artifact.id, 'wf_Const');
    assert.equal(r.sites[0]!.category, 'managed');
  });

  test('an in-house fork class named SwfteClient does not count', () => {
    const src = ['package com.acme;', 'import com.acme.fork.SwfteClient;', 'class L {', '  SwfteClient c = new SwfteClient();', '  void f() { c.workflows().invoke("wf_F", java.util.Map.of()); }', '}', ''].join('\n');
    assert.deepEqual(run(src).sites, []);
  });

  test('a chain hanging off a builder (no variable) is one site at the first line of the call', () => {
    const src = cls(
      [
        '  void f() {',
        '    SwfteClient.builder().apiKey("k").build()',
        '        .workflows()',
        '        .invoke("wf_B", Map.of("d", 1));',
        '  }',
      ].join('\n'),
    );
    const r = run(src);
    assert.equal(r.sites.length, 1);
    assert.equal(r.sites[0]!.line, 8, 'multiline call line is the first line of the call expression');
  });
});

describe('java symbols and dynamic ids', () => {
  test('symbol: lambda uses named ancestor; constructors, static blocks and field initialisers have Class.<init>/<clinit>', () => {
    const src = [
      'package com.acme;',
      'import com.swfte.sdk.SwfteClient;',
      'import java.util.*;',
      'class Svc {',
      '  static SwfteClient client;',
      '  static final Object A = client.agents().chat("ag_S1", "x");',
      '  final Object B = client.agents().chat("ag_S2", "x");',
      '  static { client.agents().chat("ag_S3", "x"); }',
      '  Svc() { client.agents().chat("ag_S4", "x"); }',
      '  void lam(List<String> xs) {',
      '    xs.forEach(x -> client.agents().chat("ag_S5", x));',
      '    Runnable r = new Runnable() { public void run() { client.agents().chat("ag_S6", "x"); } };',
      '  }',
      '}',
      '',
    ].join('\n');
    const r = run(src);
    assert.deepEqual(
      r.sites.map((s) => [s.line, s.artifact.id, s.symbol]),
      [
        [6, 'ag_S1', 'Svc.<clinit>'],
        [7, 'ag_S2', 'Svc.<init>'],
        [8, 'ag_S3', 'Svc.<clinit>'],
        [9, 'ag_S4', 'Svc.<init>'],
        [11, 'ag_S5', 'Svc.lam'],
        [12, 'ag_S6', 'Svc.lam'],
      ],
    );
  });

  test('an enum constant body is named by the enum static initialiser', () => {
    const src = ['package com.acme;', 'import com.swfte.sdk.SwfteClient;', 'enum E { A { void z(SwfteClient c) { c.agents().chat("ag_E", "x"); } } }', ''].join('\n');
    assert.deepEqual(run(src).sites.map((s) => s.symbol), ['E.<clinit>']);
  });

  test('java overload arity suffix', () => {
    const src = cls(
      [
        '  String send(String m, String u) { return client.agents().chat("ag_O", m).getResponse(); }',
        '  String send(String m, String u, String c) { return client.agents().chat("ag_O", m).getResponse(); }',
        '  String other(String m) { return client.agents().chat("ag_O", m).getResponse(); }',
      ].join('\n'),
    );
    assert.deepEqual(run(src).sites.map((s) => s.symbol), ['Svc.send#2', 'Svc.send#3', 'Svc.other']);
  });

  test('dynamic id from env is unresolved with envVarName', () => {
    const src = cls(
      [
        '  @Value("${SWFTE_SUPPORT_AGENT_ID}") private String supportAgent;',
        '  @Value("${swfte.agents.billing}") private String billingAgent;',
        '  void a() { client.agents().chat(supportAgent, "x"); }',
        '  void b() { String id = System.getenv("SWFTE_REPORT_WF"); client.workflows().invoke(id, Map.of("w", 1)); }',
        '  void c(String workflowId) { client.workflows().invoke(workflowId, Map.of("w", 1)); }',
        '  void d() { client.agents().chat(billingAgent, "x"); }',
      ].join('\n'),
      'import org.springframework.beans.factory.annotation.Value;',
    );
    const r = run(src);
    assert.equal(r.sites.length, 4);
    for (const s of r.sites) {
      assert.equal(s.category, 'dynamic');
      assert.equal(s.artifact.unresolved, true);
      assert.equal(s.artifact.id, null, 'an unresolved id is never guessed');
      assert.equal(s.detector, 'java.dynamic');
    }
    assert.deepEqual(r.sites.map((s) => s.artifact.envVarName ?? null), ['SWFTE_SUPPORT_AGENT_ID', 'SWFTE_REPORT_WF', null, null]);
  });
});

describe('java keys', () => {
  test('Map.of, Map.ofEntries, new HashMap puts and a variable bound to such a literal', () => {
    const src = cls(
      [
        '  void f(String a) {',
        '    client.workflows().invoke("wf_K", Map.of("zeta", a, "alpha", 1));',
        '    client.workflows().invoke("wf_K", Map.ofEntries(Map.entry("one", 1), Map.entry("two", 2)));',
        '    Map<String, Object> m = new HashMap<>();',
        '    m.put("p", 1);',
        '    m.put("q", 2);',
        '    client.workflows().invoke("wf_K", m);',
        '    Map<String, Object> lit = Map.of("k", 1);',
        '    client.workflows().invoke("wf_K", lit);',
        '    client.workflows().getExecutionHistory("wf_K");',
        '  }',
      ].join('\n'),
    );
    assert.deepEqual(run(src).sites.map((s) => s.inputKeys), [['alpha', 'zeta'], ['one', 'two'], ['p', 'q'], ['k'], []]);
  });

  test('kwargs input gives wildcard: a Map passed in whole, a conditional put, a parameter', () => {
    const src = cls(
      [
        '  void f(Map<String, Object> body, boolean c) {',
        '    client.workflows().invoke("wf_S", body);',
        '    Map<String, Object> m = new HashMap<>();',
        '    m.put("a", 1);',
        '    if (c) { m.put("b", 2); }',
        '    client.workflows().invoke("wf_S", m);',
        '    client.workflows().invoke("wf_S", build());',
        '  }',
        '  Map<String, Object> build() { return null; }',
      ].join('\n'),
    );
    assert.deepEqual(run(src).sites.map((s) => s.inputKeys), [['*'], ['*'], ['*']]);
  });

  test('output cut at index, read through a variable, envelope getters excluded', () => {
    const src = cls(
      [
        '  Object f() {',
        '    var run = client.workflows().invokeAndWait("wf_O", Map.of());',
        '    String id = run.getExecutionId();',
        '    Map<String, Object> out = run.getOutputs();',
        '    return ((List<Object>) out.get("articles")).get(0) + "" + run.getOutputs().get("meta") + id;',
        '  }',
      ].join('\n'),
    );
    assert.deepEqual(run(src).sites[0]!.outputKeys, ['articles', 'meta']);
  });

  test('a field read and stored in a variable still counts as an output key', () => {
    const src = cls(
      ['  void f() {', '    var run = client.workflows().invokeAndWait("wf_V", Map.of());', '    Object title = run.getOutputs().get("title");', '    Map<String, Object> out = run.getOutputs();', '    var n = out.get("count");', '  }'].join('\n'),
    );
    assert.deepEqual(run(src).sites[0]!.outputKeys, ['count', 'title']);
  });

  test('output passed whole', () => {
    const src = cls(
      [
        '  void f() {',
        '    var run = client.workflows().invokeAndWait("wf_W", Map.of());',
        '    sink(run.getOutputs());',
        '  }',
        '  void sink(Object o) {}',
      ].join('\n'),
    );
    assert.deepEqual(run(src).sites[0]!.outputKeys, ['*']);
  });

  test('a result that is only discarded has no output keys', () => {
    const src = cls('  void f() { client.workflows().invoke("wf_N", Map.of("a", 1)).getExecutionId(); }');
    assert.deepEqual(run(src).sites[0]!.outputKeys, []);
  });
});

describe('java raw HTTP', () => {
  const gateway = (body: string): string =>
    [
      'package com.acme;',
      'import java.net.URI;',
      'import java.net.http.*;',
      'import java.util.*;',
      'import org.springframework.web.client.RestTemplate;',
      'import org.springframework.web.reactive.function.client.WebClient;',
      'class Gw {',
      '  private static final String SWFTE = "https://api.swfte.com/agents";',
      '  private RestTemplate rest; private WebClient web; private HttpClient http;',
      body,
      '}',
      '',
    ].join('\n');

  test('RestTemplate literal URL, constant-folded URL and a {id} placeholder; java.net.http and WebClient', () => {
    const src = gateway(
      [
        '  Object a(String x) { return rest.postForObject("https://api.swfte.com/agents/v2/workflows/wf_R1/invoke", Map.of("x", x), Map.class); }',
        '  Object b() { return rest.getForObject(SWFTE + "/v2/workflows/wf_R2/executions", Map.class); }',
        '  Object c() { return rest.postForObject(SWFTE + "/v2/workflows/{id}/invoke", Map.of("q", 1), Map.class, "wf_R3"); }',
        '  Object d(String u) throws Exception {',
        '    HttpRequest req = HttpRequest.newBuilder(URI.create(SWFTE + "/v1/agents/ag_R4/chat/" + u)).POST(HttpRequest.BodyPublishers.ofString("{}")).build();',
        '    return http.send(req, HttpResponse.BodyHandlers.ofString());',
        '  }',
        '  Object e() { return web.post().uri(SWFTE + "/v2/workflows/wf_R5/invoke").bodyValue(Map.of("z", 1)).retrieve(); }',
      ].join('\n'),
    );
    const r = run(src, 'src/main/java/com/acme/Gw.java');
    assert.deepEqual(
      r.sites.map((s) => [s.line, s.category, s.sdk, s.managed, s.op, s.artifact.kind, s.artifact.id, s.inputKeys, s.symbol]),
      [
        [10, 'raw-http', 'http', 'raw-http', 'run', 'workflow', 'wf_R1', ['x'], 'Gw.a'],
        [11, 'raw-http', 'http', 'raw-http', 'read-output', 'workflow', 'wf_R2', [], 'Gw.b'],
        [12, 'raw-http', 'http', 'raw-http', 'run', 'workflow', 'wf_R3', ['q'], 'Gw.c'],
        [14, 'raw-http', 'http', 'raw-http', 'chat', 'agent', 'ag_R4', ['*'], 'Gw.d'],
        [17, 'raw-http', 'http', 'raw-http', 'run', 'workflow', 'wf_R5', ['z'], 'Gw.e'],
      ],
    );
    assert.ok(r.sites.every((s) => s.detector === 'java.raw-http'));
  });

  test('an id from a getter or env is unresolved; a foreign host is not a site; a client with a Swfte baseUrl is followed', () => {
    const src = gateway(
      [
        '  Object a(String id) { return rest.postForObject(SWFTE + "/v2/workflows/{id}/invoke", Map.of(), Map.class, id); }',
        '  Object b() { String agent = System.getenv("SWFTE_ESC_AGENT"); return rest.postForObject(SWFTE + "/v1/agents/" + agent + "/chat/u", Map.of(), Map.class); }',
        '  Object c() { return rest.postForObject("https://example.com/v2/workflows/wf_X/invoke", Map.of(), Map.class); }',
        '  Object d() { WebClient api = WebClient.builder().baseUrl(SWFTE).build(); return api.post().uri("/v2/workflows/wf_Base/invoke").bodyValue(Map.of("q", 1)).retrieve(); }',
      ].join('\n'),
    );
    const r = run(src, 'src/main/java/com/acme/Gw.java');
    assert.deepEqual(
      r.sites.map((s) => [s.line, s.category, s.artifact.id, s.artifact.envVarName ?? null]),
      [
        [10, 'dynamic', null, null],
        [11, 'dynamic', null, 'SWFTE_ESC_AGENT'],
        [13, 'raw-http', 'wf_Base', null],
      ],
    );
  });

  test('Map.put and Executor.execute with a Swfte URL string are not requests; a RestTemplate put is', () => {
    const src = gateway(
      [
        '  void a(Map<String, String> cache) { cache.put("https://api.swfte.com/agents/v2/workflows/wf_Cache/invoke", "x"); }',
        '  void b(java.util.concurrent.Executor ex) { ex.execute(null); }',
        '  void c() { rest.put("https://api.swfte.com/agents/v2/workflows/wf_Put/invoke", Map.of("a", 1)); }',
      ].join('\n'),
    );
    const r = run(src, 'src/main/java/com/acme/Gw.java');
    assert.deepEqual(r.sites.map((x) => x.artifact.id), ['wf_Put']);
  });

  test('a string that only mentions a Swfte URL is not a request', () => {
    const src = gateway('  static final String DOC = "see https://api.swfte.com/agents/v2/workflows/wf_D/invoke for details";\n  String f() { return "Orders run on " + SWFTE + "/v2/workflows/wf_D/invoke"; }');
    assert.deepEqual(run(src, 'src/main/java/com/acme/Gw.java').sites, []);
  });
});

describe('java widget templates', () => {
  test('text block iframe, bootstrap script and String.format templates are widget embeds at the element line', () => {
    const src = [
      'package com.acme;',
      'class Embeds {',
      '  static final String A = """',
      '      <iframe src="https://app.swfte.com/chat/ag_W1"',
      '              title="t"></iframe>',
      '      """;',
      '  static String b(String theme) {',
      '    return String.format("<script>new SwfteChatWidget({ agentId: \\"ag_W2\\", theme: \\"%s\\" }).mount();</script>", theme);',
      '  }',
      '  static String c(String agent) {',
      '    return String.format("<iframe src=\\"https://app.swfte.com/chat/%s\\"></iframe>", agent);',
      '  }',
      '}',
      '',
    ].join('\n');
    const r = run(src, 'src/main/java/com/acme/Embeds.java');
    assert.deepEqual(
      r.sites.map((s) => [s.line, s.symbol, s.category, s.sdk, s.op, s.artifact.id, s.detector]),
      [
        [4, 'Embeds.<clinit>', 'widget', 'widget-embed', 'embed', 'ag_W1', 'java.widget'],
        [8, 'Embeds.b', 'widget', 'widget-embed', 'embed', 'ag_W2', 'java.widget'],
        [11, 'Embeds.c', 'dynamic', 'widget-embed', 'embed', null, 'java.dynamic'],
      ],
    );
  });
});

describe('java decoys, broken files and degradation', () => {
  test('decoys produce no sites', async () => {
    const src = cls(
      [
        '  /** Example: client.workflows().invoke("wf_D", Map.of("a", 1)) */',
        '  void f() {',
        '    // client.workflows().invoke("wf_C", Map.of("a", 1));',
        '    String s = "client.workflows().invoke(\\"wf_E\\", Map.of())";',
        '  }',
      ].join('\n'),
    );
    assert.deepEqual(run(src).sites, []);
    const out = await detectProject(join(CORPUS, 'decoys'), { detectors: JAVA, envFiles: ENV_FILES });
    assert.deepEqual(out.sites, []);
    // the corpus's own decoys (test mocks, forks, generated client, vendored target/) stay out as well
    const spring = await detectProject(join(CORPUS, 'java-spring'), { detectors: JAVA, envFiles: ENV_FILES });
    const key = JSON.parse(fs.readFileSync(join(CORPUS, 'java-spring', 'answer-key.json'), 'utf8')) as { decoys: { path: string; line: number }[] };
    const hit = new Set(spring.sites.map((s) => `${s.relPath}:${s.line}`));
    for (const d of key.decoys) assert.ok(!hit.has(`${d.path}:${d.line}`), `${d.path}:${d.line} is a decoy`);
  });

  test('test sources, Mockito files and generated code are not call sites', () => {
    const body = 'void f() { client.workflows().invoke("wf_T", Map.of()); }';
    assert.deepEqual(run(cls(body), 'src/test/java/com/acme/SvcTest.java').sites, []);
    assert.deepEqual(run(cls(body), 'target/classes/Svc.java').sites, []);
    assert.deepEqual(run(cls(body, 'import org.mockito.Mockito;')).sites, []);
    assert.deepEqual(run('// Code generated by openapi. DO NOT EDIT.\n' + cls(body)).sites, []);
  });

  test('invalid syntax does not throw and gives no sites from the broken region', () => {
    const src = cls(
      ['  void ok() { client.workflows().invoke("wf_OK", Map.of("a", 1)); }', '  void broken( { client.workflows().invoke("wf_BAD", Map.of(', ''].join('\n'),
    ).replace(/\}\n$/, '');
    let r: ReturnType<typeof run> | undefined;
    assert.doesNotThrow(() => {
      r = run(src);
    });
    assert.ok(!r!.sites.some((s) => s.artifact.id === 'wf_BAD'), 'the broken call is not reported');
    assert.doesNotThrow(() => run('class {{{ ((( ]]] \x00'));
  });

  test('missing grammar degrades to no sites', async () => {
    const src = cls('  void f() { client.workflows().invoke("wf_G", Map.of("a", 1)); }');
    assert.equal(run(src).sites.length, 1);
    try {
      assert.equal(await initJavaParser('/nonexistent/tree-sitter-java.wasm'), false);
      assert.doesNotThrow(() => run(src));
      assert.deepEqual(run(src).sites, []);
    } finally {
      assert.equal(await initJavaParser(), true);
    }
    assert.equal(run(src).sites.length, 1);
  });

  test('env names are collected, never values', () => {
    const src = cls(
      [
        '  @Value("${SWFTE_API_KEY:cm-canary-default-0000}") private String key;',
        '  @Value("${swfte.api-key}") private String other;',
        '  String base() { return System.getenv("SWFTE_BASE_URL"); }',
        '  String home() { return System.getenv("HOME"); }',
        '  void f() { client.workflows().invoke("wf_E", Map.of()); }',
      ].join('\n'),
      'import org.springframework.beans.factory.annotation.Value;',
    );
    const r = run(src);
    assert.deepEqual([...new Set(r.envVarNames)].sort(), ['SWFTE_API_KEY', 'SWFTE_BASE_URL']);
    assert.ok(!JSON.stringify(r).includes('cm-canary-default-0000'), 'no value leaves the detector');
  });
});

describe('java corpus', () => {
  type KeySite = { path: string; line: number; category: string; symbol: string; sdk: string; op: string; managed: string; artifact: { kind: string; id: string | null; unresolved: boolean; envVarName?: string | null; alias?: string | null; pinnedVersion?: string | null }; inputKeys: string[]; outputKeys: string[] };

  async function compare(fixture: string, under = '') {
    const root = join(CORPUS, fixture);
    const key = JSON.parse(fs.readFileSync(join(root, 'answer-key.json'), 'utf8')) as { sites: KeySite[]; envVarNames: string[] };
    const out = await detectProject(root, { detectors: JAVA, envFiles: ENV_FILES });
    const want = key.sites.filter((s) => s.path.endsWith('.java') && s.path.startsWith(under));
    const got = out.sites.filter((s) => s.relPath.endsWith('.java'));
    assert.ok(want.length > 0, 'the fixture has Java sites');
    const fmt = (s: { path: string; line: number; artifact: KeySite['artifact']; inputKeys: string[]; outputKeys: string[] }) =>
      JSON.stringify([s.path, s.line, s.artifact.kind, s.artifact.id, s.artifact.unresolved, s.artifact.envVarName ?? null, s.artifact.alias ?? null, s.artifact.pinnedVersion ?? null, s.inputKeys, s.outputKeys]);
    assert.deepEqual(
      got.map((s) => fmt({ ...s, path: s.relPath })),
      want.map((s) => fmt(s)),
    );
    const by = new Map(got.map((s) => [`${s.relPath}:${s.line}`, s]));
    for (const w of want) {
      const g = by.get(`${w.path}:${w.line}`)!;
      assert.deepEqual([g.category, g.symbol, g.sdk, g.op, g.managed], [w.category, w.symbol, w.sdk, w.op, w.managed], `${w.path}:${w.line}`);
    }
    return { out, key };
  }

  test('java-spring: every Java answer-key site is found with the same path, line, artifact and keys', async () => {
    await compare('java-spring');
  });

  test('java-spring: @Value and System.getenv names reach envVarNames, and only SWFTE_ names', async () => {
    const out = await detectProject(join(CORPUS, 'java-spring'), { detectors: JAVA, envFiles: ENV_FILES });
    for (const n of ['SWFTE_ESCALATION_AGENT_ID', 'SWFTE_REPORT_WF']) assert.ok(out.envVarNames.includes(n), n);
    assert.ok(out.envVarNames.every((n) => n.startsWith('SWFTE_')));
  });

  test('monorepo: the Gradle billing module is found', async () => {
    await compare('monorepo', 'jvm/');
  });
});
