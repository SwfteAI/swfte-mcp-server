# preflight

The Swfte failure modes that report success, caught before they ship.

This was built across two forward-deployed engagements and lived in one of them.
It now ships with the MCP server, so the next solution gets it instead of
rediscovering it. The rule bodies here are byte-identical to the engagement
originals — deliberately vendored as plain `.mjs` and never ported to
TypeScript, because a port is a rewrite and a rewrite is exactly how a rule
quietly stops firing. Types are declared alongside in `*.d.mts`.

It still reaches outside itself for nothing — its REST client is duplicated
rather than imported — so the directory can also be copied whole into a
solution, as before.

```bash
export SWFTE_PAT=…
npm run preflight -- --manifest <path.json>
npm run preflight -- --manifest … --json report.json
npm run preflight -- --manifest … --static          # no platform calls
npm run preflight:derive -- --state state.json --out m.json
npm run preflight:mutation                          # prove the rules can fail
```

## As MCP tools

| Tool | What it does |
|---|---|
| `swfte_preflight` | Runs the 28 rules over a solution. Read-only. |
| `swfte_preflight_manifest` | Derives the manifest, with a provenance block. |
| `swfte_publish` | `POST /v2/workflows/{id}/publish`, refused unless preflight passes. |

`swfte_deploy` carries the same gate for `kind:"workflow"`. Both take
`force` + `forceReason` (publishes anyway, records the override verbatim) and
`skipPreflight` (no gate, no evidence, and the result says so).

The gate has **three** verdicts, not two. `PASS` proceeds. `BLOCKED` refuses
with the findings and their fixes. `INCONCLUSIVE` — the snapshot could not be
fetched, or a rule threw, so the sweep has a hole in it — also refuses. A gate
that reads "I could not check" as "it is fine" launders an unknown into an
assurance, which is the single defect that recurs through both engagements.

Exit codes: `0` no blocking findings · `1` could not run · `2` blocking findings.

Read-only. Every platform call it makes is a GET, one at a time — the platform
returns "fetch failed" under concurrency, and a checker that reported a healthy
solution as broken because it fanned out would be the exact class of lying check
this exists to prevent.

---

## What it checks

28 rules. The `#n` column is the numbered failure mode from the X Broker
engagement; rules with no number were found by running this tool against a
second solution.

| Rule | # | What it catches |
|---|---|---|
| `DT-CODE-RESULT-ROOT` | 1 | `{{node.field}}` where the executor files that field under `.result` |
| `DT-ROWS-NOT-STRING` | 2 | `rows` handed in as a JSON object/array, so templates never resolve |
| `DT-ROWS-BARE-REF` | 3 | `rows` as a bare `{{ref}}` to something that is not JSON text |
| `DT-FILTER-SET-TEMPLATED` | 4 | `filter`/`set` carrying `{{…}}`, which is never resolved |
| `DT-TABLE-NAME` | 5 | undeclared, templated, blank or near-duplicate table names |
| `DT-TABLE-LIVE` | 5 | declared tables that do not exist, hold a schema seed, or are strays |
| `RUN-HEADER-VS-TRACES` | 6 | execution headers disagreeing with the per-node traces, in either direction, and the two platform surfaces disagreeing with each other |
| `RUN-VARIABLE-POOL-TRIMMED` | 7 | node outputs over `OutputDataSizeGuard.MAX_BYTES` |
| `API-WORKFLOW-PUT` | 8 | build code reaching for the dead `PUT /v2/workflows/{id}` |
| `AGENT-KNOWLEDGE-EFFECTIVE` | 9 | inert `knowledgeSources`, dataset ids in a module-id field, modules with no dataset, tier below `AGENTIC` |
| `WIDGET-BRAIN-EFFECTIVE` | 10 | widgets bound through vocabulary that never lands; `DASHBOARD` brains; inert `customDomain` |
| `CHATFLOW-DOWNSTREAM-EFFECTIVE` | 10 | chatflows handing off through a field the overlay does not read, incl. `boundAgentId` |
| `GEN-UNRESOLVED-PLACEHOLDER` | 11 | `{{TODO}}`, `api.example.com`, `REPLACE_ME` |
| `GEN-UNDECLARED-INTEGRATION` | 12 | third-party integration nodes the manifest never asked for |
| `GEN-UNDECLARED-OUTBOUND` | 12 | anything that can reach a person without authorisation |
| `GEN-UNPARSEABLE-CONDITION` | 13 | regex literals and `matches` in branch conditions |
| `GEN-SANDBOX-CRYPTO` | 14 | `require('crypto')`, `createHash`, node builtins in a sandboxed code node |
| `WF-GRAPH-SOUND` | | dangling edges, unwired nodes, no entry point |
| `WF-PUBLISHED` | | workflows called live that are still drafts |
| `WIRE-RESOLVES` | | declared wires that do not resolve in the field the runtime reads |
| `COVERAGE` | | a component carrying less than the set it was commissioned to carry |
| `KNOWLEDGE-RETRIEVABLE` | | documents reporting `COMPLETED` over zero segments |
| `REF-UNRESOLVABLE-HEAD` | new | `{{token}}` naming neither a node nor a context root |
| `REF-UNDECLARED-OUTPUT-KEY` | new | reading an output key the node type does not produce |
| `WF-EDGE-PORT-UNDEFINED` | new | edge port ids serialised as the string `"undefined"` |
| `DT-BRANCHES-WRITE-SAME-SOURCE` | new | exclusive branches persisting one expression to two tables |
| `RUN-WROTE-NOTHING` | new | an insert that completed successfully having written nothing |
| `AGENT-GROUNDED-ON-EMPTY-KNOWLEDGE` | new | an `AGENTIC` agent whose only knowledge retrieves nothing, so it replies with an empty string |

Failure mode 15 — "an audit found 13 gates measured a proxy and 6 could not
fail" — is not a rule. It is `mutation.mjs`, which is why every rule above has a
declared mutation and is reported BROKEN without one.

---

## Why the rules are pure functions of a snapshot

`snapshot.mjs` fetches everything once into a plain object. Every rule is
`run(snap) -> Finding[]`. That is not style: it is what makes the negative
control real. `mutation.mjs` takes the same snapshot, breaks one thing, and
re-runs the **identical rule body**. Nothing is re-implemented for the test, so
nothing can drift between the check and its control.

`mutation.mjs` asserts both halves:

- every rule must be **silent on the clean fixture** — a rule that fires on
  correct artifacts teaches people to skip it
- every rule must **fire on each declared mutation** — otherwise it is reported
  BROKEN and the harness exits non-zero

A rule that cannot run returns `skip` with a reason, and skips are printed.
Reporting "skipped" is the point: the engagement this came from had gates
reporting reachability as *passing* when the URL was undefined.

```
28 rules · 73/73 declared mutations detected · 0 broken
```

The count is asserted by `npm run verify`, which now runs the harness. Packaging
this changed the number by zero, which was the point.

---

## The manifest, and deriving it

Components with live ids, the tables the solution may write, the integrations
and outbound channels it is authorised to use (**empty by default, opt-in**),
the wires it claims, and the field sets its surfaces must cover.

`derive.mjs` builds it, because a hand-written manifest is a parallel
description of a solution that someone has to keep in step with the solution —
the reason this did not scale past two engagements.

A manifest field is one of two completely different kinds of statement, and only
one kind can be derived:

- **fact** — the components, and the tables the graphs name. Derived. The
  machine cannot forget a component the way a person can.
- **intent** — `allowedOutbound`, `allowedIntegrations`, `coverage`, `wires`.
  **Never** derived from live state. An allow-list derived from the nodes
  present authorises whatever is present, so the check can no longer fail. A
  wire derived from the field `WIRE-RESOLVES` reads is connected by
  construction. These come from a spec, or from a person, and the default is the
  strict end: empty, so everything reports.

Three sources, in descending completeness:

```bash
--state state.json          # the id registry the build scripts already write
--spec  x.solution.json     # declared intent — the only honest source of wires
--seed  workflow:<id>       # walk out from a few ids
```

`--state` is the one to reach for. Every UUID in the registry is probed against
the platform to learn what kind it is, so it does not depend on a naming
convention — and, unlike a walk from seeds, it sees a component that is wired to
**nothing**, which is the failure preflight most exists to catch and the one a
link-walk is structurally blind to.

Every derived manifest carries `provenance`, naming per field where the value
came from, which rule branches the derivation leaves **unexercised**, and what a
human still has to write. `cli.mjs` prints it. Deriving `dataTables` from the
graph, for instance, retires `DT-TABLE-NAME`'s undeclared-name branch — so that
is stated, out loud, rather than left to read as a pass. Same discipline as
`mutation.mjs`: a check that cannot fail is reported, never counted.

`allowedIntegrations` / `allowedOutbound` are allow-lists on purpose. The X
Broker "no automatic outreach" gate was a hand-written deny-list of outbound node
types that did not contain the platform's own `EMAIL_SEND`, so it could not fail.
An allow-list fails in the opposite direction: a legitimate node you forgot to
declare produces a loud warning you fix in one line.

---

## Two things it deliberately does not do

**It does not run the solution.** Executing costs money and has side effects —
outreach that actually sends. Everything except the four `RUN-*` rules is static;
those read executions that already happened.

**It does not assert what it cannot see.** Where a rule has no input it skips and
says so, and where a node type's outputs are unknown `REF-UNDECLARED-OUTPUT-KEY`
stays quiet rather than guessing. Overstating reach is the thing this was built
to prevent.
