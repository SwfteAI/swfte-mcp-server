# Fixture corpus and answer keys (scope `cmap`) — revision 1

Location: `.wt-cmap-mcp/test/fixtures/codemap/`. Read with CONTRACT.md. Answer keys are the oracle for
CM-G1/G2: written by reading the code, committed **before** any detector exists, never edited by a
detector author. Keys are reviewed by the orchestrator (second reviewer) with
`.unlazy/cmap/scripts/key-review.mjs`.

## 1. Layout

```
test/fixtures/codemap/
  README.md                 what each fixture is for, who labelled, who reviewed
  canaries.json             see §5 (split storage; never an assembled key)
  agent-session.jsonl       see §6
  ts-next/                  Next.js app (TS/TSX/JS)             + answer-key.json + impact-key.json
  py-fastapi/               FastAPI + Celery (Python + Jinja)    + answer-key.json
  java-spring/              Spring Boot (Java + Thymeleaf)       + answer-key.json
  monorepo/                 pnpm workspace + Python pkg + Gradle module, two swfte.json + answer-key.json
  decoys/                   only decoys (key lists zero sites)   + answer-key.json
  sample-repo/              minimal TS repo for CI evidence (CM-G15) + answer-key.json
```
Every fixture is a self-contained project root with its own `.git`-less tree (scripts `git init` a temp
copy when they need history). Nothing under `test/fixtures/codemap` is executed by `npm test`.

## 2. Minimum labelled sites (per language, across all fixtures)

| Category (`category`) | ts | py | java |
|---|---|---|---|
| `managed` (typed client + SDK) | ≥ 44 | ≥ 44 | ≥ 44 (SDK only; there is no Java generated client) |
| `raw-http` | ≥ 10 | ≥ 10 | ≥ 10 |
| `widget` | ≥ 10 | ≥ 10 | ≥ 10 |
| `dynamic` (artifact unresolved) | ≥ 6 | ≥ 6 | ≥ 6 |

"ts" covers .ts/.tsx/.js/.jsx/.mjs/.cjs; html templates count for the language of their package root.
Spread across realistic files: route handlers, server actions, edge routes, services, jobs, CLI
scripts, React components, FastAPI routers, Celery tasks, Spring controllers/services/schedulers.

## 3. What must be present

- **Typed clients:** a checked-in generated client per swfte.json alias, produced by the real
  generator (`renderTypeScriptClient` / `renderPythonClient` in `src/codegen.ts`, run once by the
  fixture author through a throwaway script; commit its output). Its own internal HTTP call is listed
  under `implementations` in the key (reported once), and its callers are the sites.
- **SDK usage:** `@swfte/sdk` (`new Swfte(...)`, `client.workflows.invoke/invokeAndWait/execute/
  getExecutionHistory`, `client.agents.chat…`, `client.chatflows…`), Python `from swfte import
  SwfteClient` (`client.workflows.invoke`, `invoke_and_wait`, `get_execution_history`, agents chat),
  Java `SwfteClient.builder()…`, `client.workflows().invoke/invokeAndWait/getExecutionHistory`,
  `client.agents()…chat`.
- **Raw HTTP to the Swfte API** (`managed: raw-http`, `sdk: http`): literal URL, template literal /
  f-string with a constant host, a constant folded within the same file, `fetch`, `axios`, `httpx`,
  `requests`, `RestTemplate`, `WebClient`, `HttpClient`; plus one URL built from config (dynamic
  artifact → `dynamic`). Swfte API hosts: `api.swfte.com` and the `SWFTE_BASE_URL` env var; invoke
  paths `/v2/workflows/{id}/invoke`, `/v2/workflows/{id}/versions/{v}/invoke`,
  `/v1/agents/{id}/chat/{userId}`, `/v1/public/agents/{id}/chat`, `/v1/widgets/{id}/public/invoke`,
  `/v2/chatflows/{id}/…`.
- **Widget embeds** (`sdk: widget-embed`, `op: embed`): `<script src=…@swfte/chat-widget…>` +
  `new SwfteChatWidget({ agentId })`, React `<ChatWidget agentId=…/>` / `<EmbeddedChat …/>` from
  `@swfte/chat-widget/react`, `<iframe src="https://app.swfte.com/chat/<id>">`, the MCP agent embed
  markup (endpoint `/v1/public/agents/<id>/chat`), Jinja and Thymeleaf templates, and Python/Java string
  templates holding those.
- **Dynamic ids:** id from `process.env.SWFTE_*`, `os.environ[...]`, `settings.X`, `@Value("${…}")`,
  a DB row, a function parameter. Key: `artifact.id: null, unresolved: true`, `envVarName` only
  when an env var name is literally visible.
- **Decoys** (listed under `decoys`, never under `sites`): comments and docstrings containing calls,
  markdown code blocks (`*.md`), SDK mocks in tests (`__tests__`, `*.test.ts`, `tests/`, `src/test/java`),
  vendored `node_modules/`, `.venv/`, `target/`, `build/`, `dist/`, a checked-in generated client
  from another tool marked `@generated` / `// Code generated … DO NOT EDIT`, a fork of the SDK under
  another package name (`@acme/swfte-fork`) not listed in swfte.json, `.d.ts` stubs.
- **Env files:** `.env.example` with `SWFTE_*` names (names are expected in `envVarNames`); `.env` and
  `.env.local` holding canary values (§5) that the scanner must never open.
- **Canary plants** (§5) at the listed places.
- **Unsupported languages:** at least one `.go`, `.rb` and `.php` file with Swfte calls in `ts-next`
  or `monorepo` (key lists them under `notAnalysed`, not `sites`).

### 3.1 ts-next specifics (impact, drift, lens, fix-PR, provenance)
Workflow "Content pipeline" `workflow:wf_8K2mQ4`, alias `content-pipeline`, pinned `"3"`, contract v3:
input `{sources: string[] (required), topic: string (required), maxWords?: number}`, output
`{runId: string, articles: object[], status: string}`; v4 renames `topic` → `topics: string[]`
(required) and changes an internal prompt. Required sites:
- `src/app/api/publish/route.ts`, function `POST`: the typed-client call sending `{ sources, topic }`
  and reading `articles` (the one breaking site for v3→v4);
- `src/app/admin/drafts/page.tsx`: a site that only reads execution status of wf_8K2mQ4 (SDK
  `getExecutionHistory`, `op: read-output`, `outputKeys: []`) — safe for v3→v4;
- `scripts/backfill.ts`: raw `fetch` to `/v2/workflows/wf_8K2mQ4/invoke` — "cannot be checked";
- a site of the same workflow pinned elsewhere is in `monorepo`, not here.
`impact-key.json` lists for eight diffs (rename input, add required input, remove an output one site
reads, type change, add optional input, add output, internal prompt change, change on an artifact
pinned to another version) the exact `breaking`, `cannotCheck` and `safe` site sets by `(path, line)`,
with the v3/v4/vN contracts inline as JSON Schemas.

### 3.2 monorepo specifics
`packages/web` (pnpm, own swfte.json) pins `content-pipeline` to `"3"`; `packages/admin` (own
swfte.json) pins the same workflow to `"4"`; `py/worker` Python package; `jvm/billing` Gradle module
(Java SDK). Call sites resolve to the nearest lock above them.

### 3.3 sample-repo
One TS typed-client alias bound to a WorkflowV2, one call site, `swfte.json`, a CI script stub.

### 3.4 Fixture compilability (CM-G13)
ts-next: `tsconfig.json` with `paths` mapping `@swfte/sdk` and `@swfte/chat-widget/react` to local
type stubs in `types/` (`.d.ts`) so `tsc --noEmit -p .` passes with the repo's `typescript`.
py-fastapi: `python3 -m compileall -q .` passes; `tests/` has pytest tests using a stub package under
`tests/stubs/` put on `sys.path` by `conftest.py`. java-spring: a Maven project (Spring Boot 3.4.5,
`com.swfte:swfte-sdk:1.1.1`) that compiles offline against `~/.m2` once the SDK is installed.

## 4. answer-key.json format

```json
{
  "fixture": "ts-next",
  "labelledBy": "<agent/person id>", "reviewedBy": null,
  "sites": [
    {
      "path": "src/app/api/publish/route.ts", "line": 42, "language": "typescript",
      "category": "managed", "symbol": "POST",
      "sdk": "node", "op": "run", "managed": "typed-client",
      "artifact": { "kind": "workflow", "id": "wf_8K2mQ4", "unresolved": false, "envVarName": null, "alias": "content-pipeline", "pinnedVersion": "3" },
      "inputKeys": ["sources", "topic"], "outputKeys": ["articles"]
    }
  ],
  "implementations": [ { "path": "src/swfte/content-pipeline.ts", "line": 120 } ],
  "decoys": [ { "path": "src/lib/old.ts", "line": 7, "why": "comment" } ],
  "notAnalysed": { "go": 1 },
  "envVarNames": ["SWFTE_API_KEY", "SWFTE_BASE_URL"]
}
```
`line` is the 1-based line where the call expression (or the embed element / URL-bearing call) starts.
`symbol` follows CONTRACT §2.1. `why` ∈ `comment|docstring|markdown|test-mock|vendored|generated|fork|
dts|string-not-call`. Sites are sorted by (path, line).

## 5. canaries.json

`{"canaries": [{"id", "kind", "plantedAt": [{"path", "line"}], "parts": [..]}]}` — each canary value
is stored as ≥2 parts (and kinds `aws|github|stripe|swfte` additionally reversed per part) so no
committed file contains an assembled key; `scripts/codemap-leak-probe.ts` assembles them into
`/tmp/codemap-capture/fixture/` copies at run time. Kinds and plants: `literal` (string literal in a
call argument, `cm-canary-literal-7f3a`), `comment` (on a call line), `docstring`, `body` (text in the
enclosing function body), `env` (`.env` value of `SWFTE_API_KEY`), `envlocal` (`.env.local`),
`default` (`process.env.X ?? "…"`), `header` (a header value in a raw fetch), and real-format keys
`aws` (AKIA…), `github` (ghp_…), `stripe` (sk_live_…), `swfte` (`sk-swfte-…`). The committed fixture
files hold a placeholder token `__CANARY_<id>__` where a canary goes; the probe substitutes the value.

## 6. agent-session.jsonl

One JSON object per line: `{"t": ISO, "tool": "swfte_scaffold_client"|"swfte_add"|"editor_write",
"args": {...}, "wrote": ["path", ...], "addedBy": "claude-code", "pr": 231}`. At least two MCP writes
(one `swfte add --no-compliance`, one scaffold with `complianceScan: false`) and one `editor_write` of a
file that also contains a Swfte call (the file the gate must not claim).
