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
