# Backend contract capture

These JSON files are actual `CatalogContract` records serialized by the backend
`CatalogJson` mapper. They were captured from the fresh compiled
`SotCatalogContractProvider` with the real `SotContractProviderTest` fixture
factories. `provenance.json` records the backend commit, source hashes, capture
helper hash, fixture origin and each file hash. The driver capture log is
`../../../../.unlazy/p5-code/evidence/backend-capture.log` in this isolated task
checkout.

The capture contains 12 `everyKind()` cases, including the unknown-kind refusal,
and three additional cases: public agent, image model and pinned workflow.
Callable contracts exist for the owned workflow, agent, widget, platform chat
model and pinned workflow. Unavailable contracts retain `invoke: null`, empty
schemas and the backend reason. No endpoint is inferred for them.

`two-input-workflow.golden.json` is copied byte for byte from the backend's
committed golden. The captured unpinned workflow must equal that golden.
`BackendFixtureCapture.java` is a driver-only Java source launcher. It needs the
fresh backend test classpath, including test classes; it performs no HTTP:

```text
java --class-path <fresh Surefire java.class.path> \
  test/fixtures/phase5-contracts/BackendFixtureCapture.java \
  /private/tmp/swfte-p5-resume-20261001/as-integration \
  /private/tmp/swfte-p5-resume-20261001/mcp/test/fixtures/phase5-contracts
```

The dedicated provenance test checks all immutable fingerprints. Semantic tests
load records independently of that check, so a required-field or invocation
mutation must fail its actual compile or refusal assertion, rather than a hash
check or fixture loader.

## Keeping the golden in sync with agents-service

The backend owns `src/test/resources/catalog/g3/two-input-workflow.contract.json`.
`two-input-workflow.golden.json`, its `.sha256`, the captured unpinned workflow
(`workflow_wf_1.contract.json` + `.sha256`) and `provenance.json`'s
`derivedGoldenSha256` mirror it and move together:

```text
node scripts/sync-derived-fixture.mjs <agents-service-checkout> --check   # exit 1 on any drift
node scripts/sync-derived-fixture.mjs <agents-service-checkout> [--expect-sha <sha256>]   # copy + re-verify
```

`test/derived-fixture-sync.test.ts` fails when the golden, its `.sha256`, the
captured workflow or the provenance disagree. The last sync was from
agents-service golden sha256 `9c576a0e0f40307dc9b71effbcd456fbf028a33f97c130785ad827b76eb23fe6`
(adds `invoke.outputPath`). The other captured cases still come from the older
capture recorded in `provenance.json`; none of them declares `outputPath`.
