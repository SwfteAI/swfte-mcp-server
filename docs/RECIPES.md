# Recipes

What to say, and what happens underneath. Every recipe assumes the server is
attached (see `ATTACH.md`) and starts from a plain conversational request.

---

## Ship a workflow end to end

> "Build me a workflow that watches a Google Sheet for new leads, researches
> each one with an agent, and emails a summary via SES. Then check it works."

| Step | Tool | What it does |
|---|---|---|
| 1 | `swfte_whoami` | Confirms workspace and entitlements before spending time |
| 2 | `swfte_build` | Starts the wizard, polls to completion, returns the graph **plus a coverage report** of what your request it did and did not satisfy |
| 3 | `swfte_verify` | Graph soundness, plaintext-credential scan, publish state |
| 4 | `swfte_refine` | Fixes whatever step 3 found |
| 5 | `swfte_verify` `run:true` | Executes it and returns per-node traces |
| 6 | `swfte_deploy` | Preview: target, runtime profile, $/hr — nothing provisioned |
| 7 | `swfte_deploy` `confirm:true` | Provisions and polls to `READY` |

Step 3 is the one that earns its place. The API will happily persist a workflow
whose nodes are never wired together — `swfte_verify` catches that, and the
`nextActions` it returns are phrased so they can be fed straight back into
`swfte_refine`.

### If the build is slow

`swfte_build` returns a `sessionId` rather than failing when it outruns
`waitMs`. The build keeps going server-side:

> "Check on that build."  → `swfte_build_status`

You can also redirect it while it runs:

> "Tell it to use Postgres instead of MySQL." → `swfte_build_steer`

Steering after the build has finished returns `inactive` — use `swfte_refine`
on the result instead.

---

## Build an agent that actually uses its tools

> "Build me a support agent with access to our knowledge base, then verify it
> really uses it."

`swfte_verify` on an agent checks the things that fail *silently*:

- **Capability tier.** Below `AGENTIC` an agent will describe calling its tools
  rather than calling them. Nothing errors; the answers are just subtly made up.
- **Half-created records.** A wizard publish that raced a degraded backend
  leaves an agent with no model and `agentType: NONE_SELECTED`. That record is
  immutable — every update 500s — so the only fix is delete and rebuild, which
  the report says outright.
- **Prompt precedence.** `systemPrompt` is ignored unless `persona` *and*
  `instructions` are both blank. An agent with all three set is not running the
  prompt its author thinks it is.

To confirm tool use from the other direction, after a few real conversations:

> "Which tools has that agent actually invoked this week?"
> → `swfte_analytics_agent_tools`

---

## Run an A/B test on a chatflow

> "Set up an A/B test between v3 and v4 of the intake flow, optimising for
> completion rate."

```
swfte_experiments_create   → DRAFT with two variants
swfte_experiments_start    → RUNNING; traffic starts being assigned
swfte_experiments_assign   → which variant a given visitor gets (sticky)
swfte_experiments_record_outcome → the measurement, per session
swfte_experiments_summary  → per-variant aggregates
swfte_experiments_decide   → mark the winner
```

Two things worth knowing:

- `assign` returns **404 when the experiment is not RUNNING**. That is the
  normal signal to serve the current version, not an error.
- `decide` does not judge significance. Read `summary` first and decide like a
  human — the tool records the decision, it does not make it.

---

## Connect a provider

> "Connect our Slack workspace."

OAuth consent cannot be automated — a person has to sign in. So:

```
swfte_connect_start  → returns an authorizationUrl for the USER to open
                       (give them the link)
swfte_connect_wait   → polls until they finish, returns a secretId
```

Reference the returned `secretId` from integration nodes. If the provider is not
configured, `swfte_connect_start` says so and lists what *is* available, rather
than handing back a link that would fail after the user has already signed in.

---

## Investigate a cost spike

> "Our bill jumped this week — what happened?"

```
swfte_analytics_workspace_costs   → the shape of the increase
swfte_analytics_top_consumers     → who is driving it
swfte_analytics_workspace_models  → which models, at what unit cost
swfte_analytics_timeseries        → when it changed
swfte_analytics_anomalies         → what the backend already flagged
swfte_deployments_list            → capacity left running by mistake
```

That last one is worth checking first when the jump is sudden and flat rather
than proportional to usage — an `ALWAYS_ON` deployment nobody tore down bills
whether or not anyone uses it.

---

## Sweep everything you shipped

> "Re-check all the workflows I built this week."

`swfte_verify_batch` takes up to 25 targets and returns one consolidated report.
It runs **sequentially on purpose**: a parallel sweep with `run:true` would fire
N concurrent executions at a backend that already sheds load under pressure,
which would make the verification pass the thing that breaks.

---

## Notes on prompting these tools well

**Be specific in `swfte_build`.** "A workflow that processes leads" produces a
vague graph. Name the trigger, the steps, the integrations, and the outcome. The
generator is good; it is not telepathic.

**Read the coverage report.** `swfte_build` returns the wizard's own account of
which requirements it satisfied and which it missed. It is usually right about
what it skipped, and it is the fastest route to a good `swfte_refine`.

**Verify after every refine, not just at the end.** A refine that fixes one node
can unwire another, and the graph check is cheap.

**`swfte_run` on an unpublished workflow is fine.** It falls back to the draft
test path automatically rather than erroring on `WORKFLOW_NOT_PUBLISHED`.

**A `degraded: true` result is not your artifact's fault.** The backend sheds
load by returning `200` with empty content. Retry before changing anything.
