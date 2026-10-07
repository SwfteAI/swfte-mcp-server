# Independent persisted MCP artifact review

Reviewed source commit `c7de7723c17328f09e6a007bbbaf01dabaa90ad9` against `ae055176943815e7a510c70aa1b766e90341582a` on 2026-10-07.

The adapter translates the native persisted wizard DTO's JSON-string definitions into generated-server arrays at get, validate, verify and deploy boundaries. It preserves saved ID, generated code and package text. Flat configuration/deployment fields are mapped without inventing defaults or rewriting transport. Generated artifacts remain compatible, including omitted optional resources/prompts. Normalized persisted values can be normalized again without changes.

Malformed JSON, nonarray definitions, primitive/null/array members, missing persisted definition strings and mixed persisted/generated contracts fail closed before validation/deployment POSTs. This checks the structural serialization boundary; tool/resource/prompt semantics and configuration/deployment schema still belong to the native validator. It does not claim comprehensive schema validation in the adapter.

Independent verification used the committed source directly via tsx. The two focused suites passed 59/59 tests, zero failed/skipped; `npm run typecheck` passed. Both used the required machine-wide heavy guard at the established 5GB focused-test floor. An initial sandbox-only attempt failed creating the guard lock and produced no test result; the successful run used approved escalation. An independent temporary adapter from exact `git show` baseline failed persisted get/verify/deploy assertions while all three generated-shape positive controls passed. Scratch sources were removed. `git diff --check` passes. Tests use stubbed HTTP requests and establish contracts, not live runtime health or deployment readiness.

```sh
node /Users/dejanmaksimovic/Projects/Swfte/.unlazy/tools/heavy.mjs --min-free-gb 5 --max-wait-min 1 -- node --import tsx --test test/mcp-artifact-contract.test.ts test/mcp-contract.test.ts
node /Users/dejanmaksimovic/Projects/Swfte/.unlazy/tools/heavy.mjs --min-free-gb 5 --max-wait-min 1 -- npm run typecheck
```

The saved synthetic artifact is `30c2c45b-2c60-47d4-a1d8-5b2aa55916d7`. Its metadata says HTTP, but its unchanged generated code instantiates StdioServerTransport. This is an unresolved generation/deployment gap. Passing configuration/compiler checks do not establish an HTTP endpoint or successful deployment. Adapter verification explicitly says runtime health remains unverified; requested execution remains unsupported. No generated code was evaluated or deployed in this review. Author fixture provenance is recorded under the Studio workspace's `.unlazy/codex-rg13-20261007/sessions/mcp_adapter/`.

Source provenance:

- `src/kinds/mcp-server.ts` SHA256 `f52d8b22ced93b3bedc9889fcdadc85601d7ebf3ce8b6c798bffca5700012db5`.
- `test/mcp-artifact-contract.test.ts` SHA256 `dde145efa799aae46bac1f2043c007cb72cc706775f0902ae31bad8666c370c1`.
- `test/fixtures/mcp-persisted-quote.json` SHA256 `53b3e4c6bd6ced526a7e8865d5b566bc88f424f4f0c23493526c0902288d5350`.
