# Releasing @swfte/mcp-server

Publishing is done only by `.github/workflows/release.yml`, never from a laptop
(`prepublishOnly` refuses without `SWFTE_PUBLISH_CONFIRMED`).

## Each release

1. Bump the version in **two** places: `package.json` and `src/version.ts` (the user agent and
   generated clients read `PACKAGE_VERSION`; `test/hardening-version.test.ts` enforces it). Add a `CHANGELOG.md` entry.
2. Merge to `master` with CI green (`npm run verify:offline`, `npm audit --omit=dev --audit-level=high`).
3. Start the release from that exact `master` commit, either:
   - `git tag vX.Y.Z <sha> && git push origin vX.Y.Z`, or
   - Actions -> Release -> Run workflow on `master`, input `confirm=PUBLISH`.
   Do not do both. The `guard` job refuses any commit that is not on `master`, and
   `scripts/check-release-version.mjs` fails a tag that differs from `package.json`.
4. The run pauses at environment `npm-publish-prod`; a member of `SwfteAI/release-approvers`
   approves after reading the run. It publishes with `--provenance`. It then pauses at
   `docker-publish-prod` for the Docker Hub and GHCR images.
5. Verify: `npm view @swfte/mcp-server version`, the provenance badge on npmjs.com,
   `npx -y @swfte/mcp-server@X.Y.Z swfte --version`.

`release-on-merge.yml` dispatches step 3 automatically when a merge changes `package.json`
`version` and the repository variable `RELEASE_ON_MERGE` equals `armed`.

A publish is effectively irreversible (`npm unpublish` only within 72 hours and with no dependents).

## One-time owner setup (repository settings, not changeable from a PR)

- Move the `NPM_TOKEN` secret from repository level to the `npm-publish-prod` environment, and
  delete the repository-level copy. Same for `DOCKERHUB_TOKEN` / `DOCKERHUB_USERNAME` ->
  `docker-publish-prod`.
- Restrict both environments' deployment branches to `master` and `v*` tags; enable
  "prevent self-review" and add a second reviewer to `release-approvers`.
- Enable branch protection on `master`, secret scanning and push protection.
- After the first publish, configure npm trusted publishing for the package (npmjs.com -> package ->
  Settings -> Trusted publisher: `SwfteAI/swfte-mcp-server`, workflow `release.yml`, environment
  `npm-publish-prod`) and then delete `NPM_TOKEN`; the workflow already has `id-token: write` on
  the publish job and npm >= 11.5.1.
- Confirm the account that minted `NPM_TOKEN` can create packages in the `@swfte` scope.
