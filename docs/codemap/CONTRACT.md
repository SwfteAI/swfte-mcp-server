# Code map contract (scope `cmap`, brief 09) — revision 1

Canonical copy: `.unlazy/cmap/CONTRACT.md`. Mirrored, unchanged, as `docs/codemap/CONTRACT.md` in
agents-service (`.wt-cmap-agents`) and the MCP (`.wt-cmap-mcp`). A change bumps the revision here first.

Sources: PLAN Part C §C2, validation/code-map.md (claims CM-C1..C14), brief 09 §3, mockup
`code-map.html`. Where this file adds a field the sketches do not name, it says so under "Deviations".

## 1. Wave-0 decisions

| Id | Decision |
|---|---|
| D1 parser (P5) | TS/JS: TypeScript compiler API (`typescript` ^5.6, Apache-2.0) moved to `dependencies`. Python and Java: `web-tree-sitter` 0.25.x (MIT) with the grammar WASMs of `tree-sitter-python` 0.25.0 (MIT) and `tree-sitter-java` 0.23.5 (MIT) **vendored** as `src/codemap/grammars/tree-sitter-python.wasm` and `tree-sitter-java.wasm` (with their MIT licence texts beside them), copied to `dist/codemap/grammars/` by the build. Reason for vendoring: the grammar npm packages run a native `node-gyp-build` install script; the CLI must install without a compiler. No JVM or Python runs inside the CLI. G1 is baselined once on this choice. |
| D2 anonymous symbols (Q1) | The symbol of a call is the nearest **named** enclosing symbol; anonymous functions, arrow callbacks and lambdas contribute nothing to the name. The ordinal counts same-artifact calls in that named symbol in source order, so a call inside an anonymous callback gets the named ancestor plus its ordinal. |
| D3 attribution opt-in (Q2) | Per repo (`RepoOptIn.attribution`), plus the global flag `codemap.attribution.enabled`. SDK header defaults off. |
| D4 attribution mechanism (Q5) | Scan-time tag first: `swfte scan --tag` inserts `{ callsite: "cs_…" }` at each call and the manifest records the same id. Opt-in stack capture (`SWFTE_CALLSITE_STACK=1`) in dev/staging only, refused in production. |
| D5 attribution storage | Dedicated `CallSiteAttribution` rows (DynamoDB table `CodeMapAttribution`, 30-day TTL), never the execution's `tags` map, so repo delete leaves zero residue on execution rows (CM-C9). |
| D6 workspace key | One random 32-byte key per workspace, created server-side on first opt-in, returned by `GET /v2/codemap/key` to authenticated members of that workspace. The CLI caches it in memory only (never on disk, never in the manifest). Fingerprints and path hashes are HMAC-SHA256 with it. |
| D7 local stack | `--stack local` = the test-scope launcher `CodeMapLocalStack` in agents-service (in-memory stores, real codemap controllers/services, real `SchemaDiff`, real ownership checks) on 127.0.0.1. Never prod DynamoDB. Pending driver confirmation. |
| D8 keys wildcard | An `inputKeys`/`outputKeys` array equal to `["*"]` means the scanner could not name the keys (spread, variable passed whole). Impact treats that side as "cannot be checked", never "safe". |

## 2. Data model (PLAN §C2, brief §3.2)

```
CodeMap  { workspaceId, repo{ id, displayName?, provider, defaultBranch }, commitSha, scannedAt,
           scanner: cli|mcp|ci|agent, ref{kind: default|pr, pr?}, pathHashing, truncated,
           notAnalysed{<lang>: n}, envVarNames[], callSites[] }
CallSite { id, movedFrom?, path | pathHash, line, symbol, language,
           sdk: node|python|java|http|widget-embed,
           op:  run|chat|stream|embed|read-output|webhook-receive,
           artifact{ kind, id|null, unresolved, envVarName?, pinnedVersion, alias, environment },
           contractHash, inputKeys[], outputKeys[], managed: typed-client|raw-http,
           provenance?{ addedBy: claude-code|codex|human|studio, via: mcp|cli, pr?, at } }
CallSiteAttribution { workspaceId, callSiteId, executionId?, artifactRef, at, resultClass }   // 30-day TTL
RepoOptIn  { workspaceId, repoId, pathHashing, attribution, optedInBy, at }
VerifyResult { workspaceId, repoId, commitSha, artifactRef, alias, status: pass|fail|unchecked, drift[] }
```

Field rules:
- `repo.id` = `r_` + first 32 hex of SHA-256 of the normalised remote URL (lowercase host, no scheme,
  no credentials, no `.git`, e.g. `github.com/acme/web`). Unkeyed on purpose: the same remote in two
  workspaces is two rows keyed `(workspaceId, repoId)`, never shared. No remote: `r_` + SHA-256 of
  `local:` + absolute root path's basename + first commit SHA.
- `provider`: `github|gitlab|bitbucket|azure|other|none`.
- `language`: `typescript|javascript|python|java|html` (html = templates; bucketed for evaluation by
  the nearest package root's language).
- `sdk`: the TS generated client and the node SDK are both `node`; the Python generated client and SDK
  are both `python`; raw HTTP is `http`; any widget embed is `widget-embed`.
- **Typed-client vs SDK:** a typed-client site has `managed: typed-client` **and** a non-null
  `artifact.alias` (the swfte.json alias whose generated client it calls). An SDK site has
  `managed: typed-client` and `alias: null`. Raw HTTP has `managed: raw-http`. "Keep vN" is offered
  only for alias != null.
- `artifact.kind`: CatalogKind wire names (`workflow`, `agent`, `chatflow`, `widget`, …).
  `artifact.id` null iff `unresolved: true`; `envVarName` only when the id comes from a `SWFTE_*`
  (or other) env var whose **name** is known. Wrong-artifact rate must be 0: never guess.
- `pinnedVersion`, `contractHash`, `alias`: from the nearest `swfte.json` above the file (monorepos);
  null for SDK/raw/widget sites unless the code passes a literal version.
- `environment`: set by the **backend** on read (null from the scanner): `sandbox`,
  `live:swfte-cloud`, `live:aws:<region>` or null when unknown.
- `inputKeys`/`outputKeys`: dotted field names only, sorted, unique, ≤64 each; `["*"]` per D8.
- `movedFrom`: set when git reports the file renamed since the previous local scan (`git diff -M`).
- `ref.kind = pr` maps are ephemeral per PR and never shown as the repo's map.

### 2.1 Fingerprint (CM-C3)

```
id = "cs_" + hex(HMAC-SHA256(workspaceKey,
       "cs1\n" + repoId + "\n" + pkgId + "\n" + pkgRelPath + "\n" + symbol + "\n" + artifactKey + "\n" + ordinal))[0:24]
```
- `pkgId`: the nearest package root's name (`package.json` name, `pyproject` `[project].name`,
  `setup.cfg` name, Maven `groupId:artifactId`, Gradle `rootProject.name`/dir name), else the
  repo-relative directory of that root, else `.`.
- `pkgRelPath`: POSIX path of the file relative to that package root.
- `symbol`: D2. TS/JS: `Class.method`, `functionName`, `const name = () =>` gives `name`, object
  literal method `obj.key`, module top level `<module>`. Python: `Class.method`, `func`,
  nested `outer.inner`, module `<module>`. Java: `Class.method`, overloads suffixed `#<arity>`,
  initialisers `Class.<init>` / `Class.<clinit>`. Default export anonymous function: `default`.
- `artifactKey`: `kind:id`, or `kind:?` + envVarName (or `kind:?`) when unresolved.
- `ordinal`: 0-based index among calls with the same artifactKey in the same (file, symbol), source order.
- Never the line number. Stable under inserted lines, reformatting, comments, import reordering,
  edits in other symbols and argument changes; changes on a move to another symbol or file, a rename
  of the enclosing symbol, or a new same-artifact call before it in the symbol.

### 2.2 Path hashing
`pathHash = "ph_" + hex(HMAC-SHA256(workspaceKey, "path1\n" + repoId + "\n" + repoRelPath))[0:32]`.
In hashed mode the upload carries `pathHash` and never `path`; the server refuses `path` for a repo
opted in with `pathHashing: true`.

## 3. Manifest wire format (`codemap/manifest.schema.json`, schema id `swfte.codemap/1`)

Top level (exactly these keys; unknown keys are a violation):
`schema` ("swfte.codemap/1"), `repo` {`id`, `displayName`?, `provider`, `defaultBranch`}, `commitSha`
(40 hex), `ref` {`kind`, `pr`?}, `scannedAt` (ISO-8601 UTC), `scanner`, `pathHashing`, `truncated`,
`notAnalysed` (map lang→int, ≤16 keys), `envVarNames` (≤128 names, `^[A-Z][A-Z0-9_]{0,63}$`),
`callSites` (≤5000).

Bounds (server-enforced; any violation → 400 `ALLOWLIST_VIOLATION` with a JSON pointer, never the value,
and metric `codemap.upload.rejected{reason=allowlist_violation}`):
- body ≤ 2 MiB (gzip accepted, bound applies decoded) → else 413 `MANIFEST_TOO_LARGE`;
- `path` ≤ 400 chars, `^[A-Za-z0-9._/@+()\[\]~-]+$`, no leading `/`, no `..` segment;
- `symbol` ≤ 128, `^[A-Za-z0-9_$.<>#:-]+$` (no spaces, quotes or parentheses: a snippet cannot fit);
- key names ≤ 128, `^(\*|[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z_$][A-Za-z0-9_$-]*)*)$`;
- ids: callsite `^cs_[0-9a-f]{24}$`, pathHash `^ph_[0-9a-f]{32}$`, repo `^r_[0-9a-f]{32}$`,
  artifact id `^[A-Za-z0-9_.@:-]{1,128}$` (same as `SwfteClientHeader.ID`);
- every other string ≤ 128 and matches its enum or `^[A-Za-z0-9_.@:/+-]+$`;
- `line` 1..10^7; `pr` 1..10^9.

## 4. REST (agents-service, all under `/v2/codemap`, JSON)

Every route: authenticated; workspace = `SecurityContext.getCurrentWorkspaceId()` (never a header or
body field); flag `codemap.enabled` (global) or the workspace in `codemap.enabled-workspaces`,
otherwise **404 `{"error":"NOT_FOUND"}`**; API-key callers (`ROLE_API_USER`) need `SCOPE_ALL` or
`SCOPE_CODEMAP_READ` (GET) / `SCOPE_CODEMAP_WRITE` (POST/DELETE) else 403 `CODEMAP_SCOPE_REQUIRED`.
A repo, call site or artifact of another workspace answers the same 404 body as one that does not exist.
The raw request never reaches a log line.

| Method, path | Body / query | Answer |
|---|---|---|
| `POST /repos` | `{repoId, displayName?, provider, defaultBranch, pathHashing, attribution}` | 200 `RepoView` (upsert; creates the workspace key if absent) |
| `GET /repos` | — | 200 `{repos: RepoView[]}` |
| `DELETE /repos/{repoId}` | — | 200 `{deleted: {scans, callSites, attributions, verifyResults, optIn}}`; 404 if absent |
| `DELETE /repos` | — | 200 same shape summed over every repo (delete the whole map) |
| `POST /repos/{repoId}/manifests` | manifest | 200 `{status: stored\|duplicate, commitSha, callSites}`; 404 `REPO_NOT_OPTED_IN`; 400/413 as §3 |
| `GET /callsites` | `repoId?`, `artifactRef?` (`kind:id`), `environment?` | 200 `{callSites: CallSiteView[], repos, truncatedRepos[], staleRepos[]}` |
| `GET /callsites/{callSiteId}` | `repoId` | 200 `CallSiteDetail` |
| `GET /impact` | `artifactRef`, `from`, `to` | 200 `ImpactReport` |
| `POST /verify-results` | `{repoId, commitSha, artifactRef, alias, status, drift[]}` | 200 `{stored: true}` |
| `GET /verify-results` | `artifactRef` or `repoId` | 200 `{results: VerifyResult[]}` newest first |
| `GET /key` | — | 200 `{keyId, key}` (base64 32 bytes) for an opted-in workspace; 404 before any opt-in |
| `GET /lens` | `repoId`, `path` or `pathHash` | 200 `{items: LensItem[]}` |

Views (never any code text; no field holds a source line or string literal):
- `RepoView {repoId, displayName, provider, defaultBranch, pathHashing, attribution, optedInBy, optedInAt,
  latest: null | {commitSha, scannedAt, scanner, truncated, notAnalysed, callSiteCount, stale}}`
- `CallSiteView` = the stored CallSite + `repoId` + `repoDisplayName` + `runtime` + `drift` + `verify`:
  - `runtime: null | {calls24h, errors24h, p95Ms|null, finishedRate|null, lastError: null|{at, message≤200}}`
    (null = attribution off or no data; never a fabricated zero);
  - `drift: null | {againstVersion, breaking, changes: [{kind, side, path}]}`;
  - `verify: null | {status, commitSha, at}` (latest VerifyResult for the site's repo + alias/artifact).
- `CallSiteDetail` = `CallSiteView` + `history: [{type: verify|drift|provenance|moved, at, detail}]`
  (+ the artifact's contract field names/types for the pinned version, names and types only).
- `ImpactReport {artifactRef, from, to, verdict: known|unknown, unknownReasons: [{repoId, reason:
  missing|stale|truncated|partial, since?}], changes: [{kind, side, path}], breaking: [{site, reasons}],
  cannotCheck: [{site, reason: raw-http|unresolved|keys-unknown}], safe: [site], otherVersions: n}`.
  Never "0 would break" when `verdict = unknown`.
- `LensItem {callSiteId, line, symbol, artifact, pin, drift, calls24h, errors24h}`.

Retention: latest 10 default-branch scans per repo; PR maps expire after 14 days; attribution 30 days.
Idempotency: a manifest whose `(repoId, commitSha, ref)` is already stored answers `duplicate` and
stores nothing.

## 5. Seams inside agents-service (`com.swfte.scp.agentservice.codemap`)

- `domain` (wave 0, orchestrator): records and interfaces — `CodeMapStore`, `CallSiteRuntimeProvider`
  (W-G implements), `CallSiteDriftProvider` (W-J implements), `CodeMapFlags`.
- `ingest`, `web`, `erasure`, store implementations: W-D.
- `attribution`, `ci`: W-G. `impact`: W-J.
- `SchemaDiff.breakingChanges(...)` (W-J) returns `List<BreakingChange(kind, side, path)>` with kinds
  `REQUIRED_INPUT_ADDED, INPUT_BECAME_REQUIRED, REQUIRED_INPUT_REMOVED, INPUT_NO_LONGER_REQUIRED,
  INPUT_TYPE_CHANGED, OUTPUT_REMOVED, OUTPUT_TYPE_CHANGED`; `breaking(...)` becomes a formatting of it
  with byte-identical strings.
- Impact rule (brief §3.5) over sites pinned to `from`: REQUIRED_INPUT_ADDED / INPUT_BECAME_REQUIRED
  break every site with `op` run|chat|stream|embed; REQUIRED_INPUT_REMOVED / INPUT_TYPE_CHANGED break
  sites whose `inputKeys` hold the path or a dotted prefix of it; OUTPUT_REMOVED / OUTPUT_TYPE_CHANGED
  break sites whose `outputKeys` hold it (or a prefix); INPUT_NO_LONGER_REQUIRED, optional-added and
  output-added break nothing. raw-http, unresolved and `["*"]` sites are `cannotCheck`, never safe.

## 6. Runtime header (W6b)

`X-Swfte-Callsite: cs_<24 hex>` — exactly that, ≤27 chars, else ignored. SDKs send it only when a
`callsite` option is given, or stack capture is on (`SWFTE_CALLSITE_STACK=1`, refused when the runtime
reports production: node `NODE_ENV=production`, python `SWFTE_ENV`/`ENV`/`PYTHON_ENV=production`,
java system property `swfte.env` or env `SWFTE_ENV=production`). Stack capture resolves the calling
frame through the local caller map written by `swfte scan` (never uploaded): the scanner, which holds
the workspace key, precomputes each site's keyed fingerprint, so the SDK needs no key at runtime.
Caller map: path from env `SWFTE_CODEMAP_CALLERS`, else `<cwd>/.swfte/codemap/callers.json`:
`{"version":1,"root":"<absolute scan root>","entries":{"<posix path relative to root>:<line>":"cs_…"}}`.
The SDK takes the first stack frame outside its own package, makes its file path relative to `root`,
and sends the id for `path:line` if present; otherwise nothing. Production refusal: stack capture is
ignored (one warning), an explicit `callsite` option is still honoured. An explicit option always wins.
Invalid ids (not `^cs_[0-9a-f]{24}$`) are never sent. Default: no header.

Backend attaches (W-G) only when: `codemap.attribution.enabled`, header valid, caller authenticated,
the call site is in the **caller's** workspace's latest default-branch map of a repo opted in with
`attribution: true`, and the site's resolved artifact equals the invoked path's artifact. Unresolved
sites are not attached. Everything else: unattributed, run unaffected, metric
`codemap.attribution.dropped{reason}`.

## 7. MCP (`src/codemap/`)

`types.ts` (wave 0) holds the manifest types (mirroring §3) and the detector interface.

Module map (owner in brackets):
- `detectors/index.ts` [wave 0]: `export const DETECTORS: Detector[]` = the concatenation of
  `detectors/ts/index.ts` + `detectors/html/index.ts` [W-A] and `detectors/py/index.ts` +
  `detectors/java/index.ts` [W-B]; each of those exports `DETECTORS: Detector[]`. Detector ids are
  `<lang>.<category>[.<variant>]`, e.g. `ts.managed`, `ts.raw-http`, `html.widget`, `py.dynamic`, `java.managed`.
- `walk.ts` [W-C]: file enumeration through `ConfinedWriter`/fsguard, language by extension (html by
  package root), skip rules (vendored `node_modules`, `.venv`, `venv`, `target`, `build`, `dist`,
  `.next`, `.git`, `__pycache__`; files marked generated by another tool; `.d.ts`; never opens `.env`,
  `.env.*` except `.env.example`), package roots (`pkgId`), nearest `swfte.json` per file, caps.
- `detect.ts` [W-C]:
  ```ts
  export interface DetectOptions { detectors?: Detector[]; skipDirs?: string[]; skipGenerated?: boolean;
    maxFiles?: number; maxFileBytes?: number; preprocess?: (f: SourceFile) => SourceFile }
  export interface DetectOutcome { sites: DetectedSite[]; implementations: Implementation[];
    envVarNames: string[]; notAnalysed: Record<string, number>; truncated: boolean; filesScanned: number;
    packages: Map<string, { pkgId: string; pkgRelPath: string }> /* keyed by relPath */ }
  export function detectProject(root: string, opts?: DetectOptions): Promise<DetectOutcome>;
  ```
  Defaults come from `walk.ts`; the eval's mutants pass options (drop detectors, empty `skipDirs`,
  a `preprocess` that turns comments into code) or post-process the outcome (guess dynamic ids).
- `fingerprint.ts`, `manifest.ts` (allowlist serializer), `upload.ts`, `queue.ts` [W-C];
  `scan.ts`, `tag.ts` [W-F]; `impact.ts` [W-J]; `lens.ts` [W-K].

The upload
module `upload.ts` is the only network path and never imports `src/compliance.ts`. CLI: `swfte scan
[--tag] [--hash-paths] [--offline] [--json] [--ci] [--pr <n>]`; queue dir `.swfte/codemap/queue/`
(manifest JSON only, named `<commitSha>.json`); cache `.swfte/codemap/` is added to `.gitignore`
advice. Output tokens: `SWFTE_SCAN_UPLOADED <n> call site(s)`, `SWFTE_SCAN_QUEUED <path>` (exit 0),
`SWFTE_SCAN_DUPLICATE`. Never print "uploaded" for a queued manifest.

## 8. Studio (`/v2/studio/code-map`)

Service types mirror §4 views exactly. No demo fallback for a real workspace: an empty API answer
renders the empty state. The route hides itself (no nav entry) when `GET /v2/codemap/repos` answers 404.

## 9. Flags (all default off)

`codemap.enabled`, `codemap.enabled-workspaces` (empty), `codemap.attribution.enabled`,
`codemap.impact.enabled`, `codemap.githubApp.enabled`, `codemap.lens.enabled` (MCP env
`SWFTE_CODEMAP_LENS=1`), SDK `SWFTE_CALLSITE_STACK`.

## 10. Deviations from the sketches (recorded)

1. `artifact.unresolved: boolean` encodes the sketch's `id | unresolved`.
2. `CodeMap.envVarNames[]` added (the mockup's upload shows `env`; the sketch has only per-site `envVarName`).
3. `CodeMap.ref`, `pathHashing` added (PR-branch ephemeral maps; hashed-mode refusal).
4. `["*"]` keys wildcard (D8).
5. Typed-client vs SDK told apart by `alias` (no new enum value).
