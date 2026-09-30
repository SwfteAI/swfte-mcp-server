# Security policy

## Supported versions

The latest minor release of `@swfte/mcp-server` receives security fixes. Releases before
0.2.0 were never published to npm.

| Version | Supported |
| ------- | --------- |
| 0.2.x   | yes       |

## Reporting a vulnerability

Please do not open a public issue. Email **security@swfte.com** with a description, the
affected version and, if possible, a minimal reproduction. You can also use GitHub's
private vulnerability reporting on this repository. We acknowledge reports within 3
business days and aim to ship a fix or mitigation within 30 days for confirmed issues. We
credit reporters who want credit.

## What this package is, in security terms

An MCP server runs with your credential, inside your project directory, driven by a model
that also reads text it did not write (catalog entries, web pages, files). The design assumes
that text can be hostile.

- **Credential.** Read from `SWFTE_PAT` / `SWFTE_API_KEY` in the environment only, sent only
  to `SWFTE_BASE_URL` (https, or http on loopback unless you set
  `SWFTE_ALLOW_INSECURE_BASE_URL=1`). HTTP redirects are never followed, so a credential
  cannot be replayed to another origin. It is never written to disk; the file writer refuses
  content that contains it or a secret-shaped string.
- **Local files.** Paths are confined to the directory the server was started in (no `..`,
  no absolute paths elsewhere, no symlink escapes). A deny-list sits inside that: `.git/`,
  `.github/`, `.husky/`, `.vscode/`, `.claude/`, `.cursor/`, `.mcp.json`, `.npmrc`,
  `package.json` and `.env*` (except `.env.example`) are never written; `.env*`, `.npmrc`,
  `.netrc`, `.git/`, `.ssh/`, `.aws/` and private-key files are never read or uploaded.
  Existing files are never replaced without an explicit `force`.
- **Generated code and markup** come from the Swfte catalog. Contract hashes and paths are
  validated before they reach generated source, but you should review generated clients and
  embed markup like any dependency. `swfte_embed_widget` shows the markup and writes nothing
  until you confirm.
- **Approvals.** Nothing in this package approves an action on your behalf. Resolving a
  human-in-the-loop gate is off unless an operator sets `SWFTE_ALLOW_GATE_DECISIONS=1`;
  deploys need `SWFTE_ALLOW_DEPLOY=1` and `confirm:true`.
- **Supply chain.** No install scripts. Releases are published from GitHub Actions with npm
  provenance, from `master` only, behind a reviewer-gated environment. The tarball contains
  `dist/`, docs and `src/preflight` (checked by `node scripts/check-pack.mjs`).

## Out of scope

A personal access token acts as you with your full authority; prefer a scoped workspace
API key. Launch the server from the project directory, never from `$HOME` or `/`.
