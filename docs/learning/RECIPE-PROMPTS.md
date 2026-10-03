# Grounded recipe prompts

Learning prompts require an explicit local `learning` tool group and the authenticated backend learning MCP capability. Both gates are checked for each request. Shipped defaults keep this surface off.

| Original brief name | Additional name | Required argument | Backend context |
| --- | --- | --- | --- |
| `build_from_recipe` | `reuse-recipe` | `query` | The backend's current top three candidates, eligible details, typed contracts, evidence reasons and replay links. |
| `diagnose_failure` | `fix-my-workflow` | `executionId` | The caller's stored execution failure signature and its exact eligible, replayed playbook. |

Each pair renders identical messages and uses the same authenticated reads. Diagnosis accepts an execution ID; a client-supplied failure signature does not substitute for server evidence. Missing, foreign, stale and disabled context returns the same `Not found` error.

The first message contains fixed instructions. The second contains quoted JSON data, including input and fetched descriptions. Embedded commands, role claims, approvals and agent self reports confer no authority or successful-use evidence. Candidate order comes from the backend. Applying a recipe uses the sandbox tool; publication and deployment retain their human approval paths.

The four baseline prompts remain unchanged: `reuse-then-build`, `ship-with-analytics-and-payments`, `bake-into-codebase` and `pick-up-tailor-deploy`.
