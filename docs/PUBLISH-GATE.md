# The publish gate

Publishing is the promotion boundary. It is the last point at which a defect is
still cheap, and the first point after which someone believes the thing works.
So it is where the sweep belongs.

This document covers both halves: the half that is implemented (in this server),
and the half that is designed but deliberately not implemented (in
`agents-service`), with the reason and the exact seam.

---

## What is implemented, here

`swfte_publish` calls `POST /v2/workflows/{id}/publish` — but only after
`gate()` in `src/preflight.ts` returns a verdict that allows it.

```
swfte_publish { workflowId }
  → manifest: given, or DERIVED from the workflow (src/preflight/derive.mjs)
  → snapshot: one serial GET pass (src/preflight/lib/snapshot.mjs)
  → 28 rules, unchanged bodies (src/preflight/lib/rules.mjs)
  → verdict
       PASS          → POST /v2/workflows/{id}/publish
       BLOCKED       → refuse, return the findings and their fixes
       INCONCLUSIVE  → refuse
```

`swfte_deploy` carries the same gate for `kind:"workflow"`, before it provisions
anything. Deploying a workflow whose templates all resolve to the empty string
buys capacity to run nothing, at cost, and every node still reports COMPLETED —
so the deployment looks healthy in exactly the way this rule set exists to
disprove.

### Three verdicts, not two

`INCONCLUSIVE` is the load-bearing one. It fires when the snapshot could not be
fetched, or when a rule threw and the sweep therefore has a hole in it. It
refuses just like `BLOCKED` does.

A gate that reads "I could not check" as "it is fine" launders an unknown into
an assurance. That is the single defect that recurs through both engagements
this rule set came from — a gate reporting reachability as *passing* while the
URL was `undefined`.

For the same reason, a **skipped** rule is never counted as a pass. Skips are
returned in their own field, and `PASS` says so in its `reason` when any rule
skipped.

### The overrides, and how they differ

| Flag | Effect | Evidence produced |
|---|---|---|
| `force: true` + `forceReason` | Publishes despite `BLOCKED`/`INCONCLUSIVE`. The **verdict does not change** — only `allowed` does, and `reason` carries the override text verbatim. | Full report, with the override in it |
| `skipPreflight: true` | No gate runs at all. | **None.** The result carries an explicit warning saying so. |

They are deliberately not the same flag. `force` is a person taking
responsibility on the record. `skipPreflight` is choosing to have no record.

---

## What is designed, not implemented: the backend seam

### Why not implemented

Three other agents were concurrently editing `DataTableNodeExecutor`, the wizard
services, and adding a validator service — the last of which lands in exactly
the package this change belongs in. `agents-service` also had 103 modified files
from an unrelated in-flight feature on a branch that is not mine. The required
`mvn clean package` plus jar boot test would have been running against their
half-finished work, and a failure would have been unattributable to either of
us. So: designed here, implemented MCP-side.

### The seam

`WorkflowServiceV2.publishWorkflow` already **is** the promotion gate, and
already rejects there:

```
src/main/java/com/swfte/scp/agentservice/services/v2/WorkflowServiceV2.java:1884
    public WorkflowVersion publishWorkflow(String workflowId, String releaseNote, String userId)

:1891  // R3: the canvas's real flow is syncDraftWorkflow (lenient, writes straight to the
       // live record) → publishWorkflow. Without validation here, a dangling-endpoint edge
       // saved leniently as a draft published fine and 500'd on first run. Publish is the
       // promotion gate: dangling edges / LOOP back-edges 400 here. Draft sync stays lenient.
:1894  enforceEdgeStructureForSave(wf);
```

That comment is the whole argument, already made and already accepted in this
codebase. The structural half of the gate is in. What is missing is the semantic
half — and the semantic half is where the damage lives, because a graph can be
perfectly sound and still resolve every template to the empty string.

The insertion point is one line, immediately after `:1894`:

```java
enforceEdgeStructureForSave(wf);
enforceSemanticsForPublish(wf);          // <- new
```

modelled on its neighbour at `:2949`:

```
:2949  private void enforceEdgeStructureForSave(WorkflowV2 workflow) {
:2950      var result = workflowDefinitionValidator.validateEdgeStructure(workflow);
           … warnings logged, errors collected …
:2961      metricsCollector.recordCounter("workflow.save.edge_validation_failed", 1);
:2962      throw new WorkflowValidationException("Invalid workflow edges: " + detail);
```

### Where the rules go

`core/v2/workflow/validation/WorkflowDefinitionValidator.java:27` is the class,
and it already carries the shape this needs — `ValidationIssue.error(...)` /
`.warning(...)`, a `ValidationResult` with `isValid()`, `errors()` and
`warnings()`. Add one sibling to `validate` (`:90`) and `validateEdgeStructure`
(`:160`):

```java
public ValidationResult validateSemantics(WorkflowV2 workflow)
```

carrying the subset of the 28 rules whose entire input is the workflow record —
no executions, no cross-artifact state, no local build sources. From
`src/preflight/lib/rules.mjs`, that subset is:

| Rule | Severity at publish |
|---|---|
| `DT-CODE-RESULT-ROOT` | error |
| `DT-ROWS-NOT-STRING` | error |
| `DT-ROWS-BARE-REF` | error |
| `DT-FILTER-SET-TEMPLATED` | error |
| `DT-TABLE-NAME` (blank / templated / near-duplicate branches) | error |
| `DT-BRANCHES-WRITE-SAME-SOURCE` | error |
| `GEN-UNRESOLVED-PLACEHOLDER` | error |
| `GEN-UNPARSEABLE-CONDITION` | error |
| `GEN-SANDBOX-CRYPTO` | error |
| `REF-UNRESOLVABLE-HEAD` | error |
| `REF-UNDECLARED-OUTPUT-KEY` | error |
| `WF-EDGE-PORT-UNDEFINED` | error |
| `WF-GRAPH-SOUND` | error — overlaps `validateEdgeStructure`; keep both, they disagree on unwired nodes |

Severities are the rules' own (`severity: 'block'` in `rules.mjs`), carried
across unchanged. Every one of the thirteen is `block` there, so every one is an
`error` here. Do not downgrade one on the way in: a rule demoted to a warning at
the gate is a rule that no longer gates, and the demotion will not be revisited.

The rest stay client-side, and should: `GEN-UNDECLARED-INTEGRATION` and
`GEN-UNDECLARED-OUTBOUND` need an authorisation the backend has nowhere to read
from; `COVERAGE` and `WIRE-RESOLVES` need declared intent; the four `RUN-*`
rules need execution history; `API-WORKFLOW-PUT` needs the operator's own build
scripts.

### The three things that will bite

1. **Four callers, not one.** `publishWorkflow` is reached from
   `WorkflowControllerV2.java:912`, `WorkflowVersionServiceImpl.java:64` and
   `:195`, and `RelayDeploymentService.java:422`. Putting the check inside
   `publishWorkflow` covers all four. Putting it in the controller covers one,
   and the Relay deploy path would publish ungated — which is the path that
   matters most.

2. **Existing published workflows will now fail to re-publish.** X Broker's
   XB-03 has 15 blocking findings today. That is correct — they are real, and
   the workflow does not do what it reports doing — but it is a behaviour change
   for live workspaces. Ship it behind a property
   (`swfte.workflow.publish.semantic-gate`, default `false`), turn it on for new
   workspaces, and announce it before flipping the default. The MCP-side gate
   needs no such ramp because the client chooses to call it.

3. **A validator that throws is not a validator that passed.** Wrap the new
   check so an unexpected exception fails the publish rather than being caught
   and logged. `enforceEdgeStructureForSave` gets this right by not catching;
   `logDraftEdgeStructureIssues` at `:2971` deliberately swallows, and copying
   *that* shape would produce precisely the check-that-cannot-fail this whole
   apparatus exists to prevent.

### Proving it, when it is built

Not "the build is green". `mvn clean package` has twice hidden a startup failure
in this repo, so: `mvn clean package`, then boot the jar and confirm liveness and
readiness, then port the mutation harness. Every rule ported must have a test
that breaks one thing in a workflow fixture and asserts the publish is rejected —
and a rule with no such test is reported broken, not passing. That discipline is
the reason the count in this package is `73/73` and not a number nobody checked.
