# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 - 2026-09-30

First release published to npm (the `v0.1.0` tag was never published).

### Security

- Generated clients: the contract hash is accepted only as a hex digest and every
  server-supplied string is escaped, so a hostile catalog response cannot inject code into a
  generated TypeScript or Python client. Invoke and status paths must be plain absolute paths;
  generated clients assert the request origin equals the base URL and never follow redirects.
- `swfte_export_src` writes through the confined writer: no silent overwrite of existing files
  (new `force` flag), no writes through symlinks, `..`/absolute zip entries are refused, and
  unpacking is size-capped.
- API requests use `redirect: manual`; a 3xx is an error. Previously a cross-origin redirect
  carried `X-API-Key` and `X-Workspace-ID`.
- Path deny-list for file tools (see SECURITY.md). `package.json` writes are refused outright.
- `swfte_embed_widget` returns the markup for review and needs `confirm: true` to write; it only
  accepts widgets from your own workspace or verified public entries, and only `https` script
  sources on Swfte domains.
- `swfte_relay_runs_gate_decide` is hidden unless `SWFTE_ALLOW_GATE_DECISIONS=1`.
- Catalog search / context / evidence / dependency results carry an untrusted-content advisory.
- `SWFTE_BASE_URL` must be https, or http on loopback (override: `SWFTE_ALLOW_INSECURE_BASE_URL=1`).
- Windows browser launch uses `rundll32` instead of `cmd /c start`.
- Fatal errors are redacted before they reach stderr.
- Every configured credential, including short ones and their JSON-escaped and percent-encoded forms, is scrubbed from
  errors, diagnostics and the CLI/stdio fatal paths, and refused in uploaded or exported files.
- `swfte_export_src` with `overwrite: true` validates the new export in a sibling directory and swaps it in; a refused
  download no longer deletes the previous export.
- `swfte_get_openapi` results carry the untrusted-content advisory.
- Dependency advisories fixed (`npm audit --omit=dev` is clean; CI enforces it).

### Added

- Generated TypeScript and Python clients follow the backend's `invoke.outputPath` to the declared workflow output.
- `scripts/sync-derived-fixture.mjs` syncs and verifies the G3 golden against an agents-service checkout.

### Packaging and release

- Source maps ship without `sourcesContent`; absolute maintainer paths removed from shipped JSON.
- `main`/`types` removed (importing the entry would start a stdio server); internal
  `PUBLISH-GATE.md` no longer ships.
- Release workflow: actions pinned to commit SHAs, `id-token`/`packages` scoped per job,
  master-only guard, npm provenance. Docker image pinned by digest and built with `npm ci`.
- The user-agent version comes from `PACKAGE_VERSION`.
