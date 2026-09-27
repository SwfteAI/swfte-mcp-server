# Code-map fixture corpus

Hand-labelled projects that the code-map scanner (`src/codemap/`) is measured against. Spec:
`docs/codemap/FIXTURES.md`; data model: `docs/codemap/CONTRACT.md`. Nothing here is run by `npm test`.

The answer keys were written by reading the code, before any detector existed. Never edit an
`answer-key.json` or `impact-key.json` to make a detector pass; if a key is wrong, the corpus author fixes it
and the orchestrator re-reviews it.

| Fixture | What it is for | Labelled by | Reviewed by |
|---|---|---|---|
| `ts-next/` | Next.js App Router app: route handlers, server actions, an edge route, React components, `scripts/`, `lib/`, public HTML. Three generated typed clients (`content-pipeline` unpinned on the v3 hash, `invoice-triage` pinned to "2", `support-agent`). Impact, drift, lens, fix-PR and provenance run against it (`impact-key.json`, `../agent-session.jsonl`). Also holds decoys, canary plants and one `.go`, `.rb` and `.php` file (not analysed). | opus leaf-1.1.2 | null |
| `monorepo/` | pnpm workspace: `packages/web` pins `content-pipeline` to "3", `packages/admin` pins it to "4" (each has its own `swfte.json` and generated client); `py/worker` Python package with a generated Python client; `jvm/billing` Gradle module on the Java SDK. Call sites resolve to the nearest `swfte.json` above them. | opus leaf-1.1.2 | null |
| `decoys/` | Only decoys (markdown, comments, docstrings, test mocks, vendored and built code, another tool's generated client, an SDK fork, a `.d.ts`, strings that mention calls). Its key has zero sites. | opus leaf-1.1.2 | null |
| `sample-repo/` | Minimal TS repo for CI evidence (CM-G15): one typed-client alias bound to a WorkflowV2, one call site, `ci/codemap.sh`. | opus leaf-1.1.2 | null |
| `py-fastapi/`, `java-spring/` | Python and Java corpora, written by a separate leaf; see their own keys. | (their author) | null |

`canaries.json` lists the leak canaries. Committed files hold only `__CANARY_<id>__` placeholders; the values
are stored in two or more parts (the real-format kinds `aws`, `github`, `stripe`, `swfte` also reversed per
part) and are assembled only at run time into `/tmp` copies by `scripts/codemap-leak-probe.ts`.

`agent-session.jsonl` is an agent session against `ts-next` (paths relative to `ts-next/`): two MCP writes
(`swfte add --no-compliance`, a scaffold with `complianceScan: false`) and one `editor_write` of
`src/app/api/publish/route.ts`, which contains a Swfte call but was not written by an MCP tool, so the
provenance gate must not claim it.

## Labelling conventions (where FIXTURES.md §4.1 leaves a choice)

- **Output root.** Generated client: `res.output`. SDK: the SDK's real field, `outputs` (node and python
  `WorkflowExecutionStatus.outputs`, Java `getOutputs()`), so `done.outputs?.score` gives `score`. A local
  alias of the root counts (`const out = res.output; out?.status` gives `status`). Python and Java string-key
  subscripts are field access (`result["output"]["score"]`, `getOutputs().get("score")` give `score`);
  numeric or variable subscripts are index access and cut the path.
- **Chat replies.** SDK chat replies have no output root, so reading `reply.response` gives `[]`. The typed
  chat client's `res.reply` is an envelope field; `res.output?.content` gives `content`.
- **Raw HTTP.** `inputKeys` are the keys of the object literal sent as the body (`JSON.stringify({...})`,
  axios data, `json=`, `Map.of`); a variable or parameter body gives `["*"]`. `outputKeys` are always `[]`.
  A literal `/versions/N/invoke` path sets `pinnedVersion: "N"`.
- **Read-output ops** (`getExecutionHistory`, `listSessions`, `stats`) have `inputKeys: []`; their filter
  arguments are not artifact inputs.
- **Chatflow `startSession`** is `op: chat`.
- **Widget sites** carry `managed: typed-client` (the contract has no third value) with `alias: null`. The
  site line is the embed element (`<ChatWidget`, `<EmbeddedChat`, `<iframe`) or the `new SwfteChatWidget(`
  expression, never the loader `<script src>`. For the MCP agent embed markup it is the `var cfg = {...}`
  line that holds the `/v1/public/agents/<id>/chat` endpoint.
- **Dynamic.** A call over a loop variable is unresolved even when the loop array is a literal (a site has one
  artifact; never guess). `envVarName` is set only where the env var name is on the call itself.
- **Symbols** follow CONTRACT §2.1: anonymous callbacks take the named ancestor; `export default async function (…)`
  is `default`; HTML files and module scope are `<module>`; Java overloads get `#<arity>`.
- **Not sites** (and not listed as decoys): SDK construction, imports, `agents.get`, and calls through
  non-Swfte clients.
- **envVarNames** = the `SWFTE_*` names in the fixture's `_env/dot-env.example`, plus every site's
  `envVarName` (this adds `NEXT_PUBLIC_SWFTE_AGENT_ID` in `ts-next`, which is on a call but is not a `SWFTE_*` name).

## Env files (CONTRACT D10, deviation 6)

No `.env*` file exists anywhere in this corpus, and no script may create one. The env plants use neutral
names under each fixture's `_env/` directory:

- `ts-next/_env/dot-env` (canary `env`) and `ts-next/_env/dot-env.local` (canary `envlocal`) hold canary
  placeholders. The scanner must never open them.
- `ts-next/_env/dot-env.example`, `monorepo/_env/dot-env.example` and `sample-repo/_env/dot-env.example`
  hold `SWFTE_*` names only. The scanner reads them for names, never values.

The scanner finds env files through a configured list of basename globs (`DetectOptions.envFiles`). The
production default is `{secret: ['.env', '.env.local', '.env.*'], names: ['.env.example']}`. Every eval or
probe run over this corpus passes `{secret: [...default, 'dot-env', 'dot-env.*'], names: [...default,
'dot-env.example']}`, so the `dot-env*` files follow exactly the rules that production applies to `.env*`.
