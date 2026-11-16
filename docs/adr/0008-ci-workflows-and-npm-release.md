# 0008. CI workflows and the npm release pipeline

- Status: accepted
- Date: 2026-11-17
- Code: `.github/workflows/{lint,test,release}.yml`, `packages/guijam/`, `scripts/smoke-package.sh`

## Context

One `ci.yml` ran every gate and nothing was published. Francis asked for separate lint and test workflows, and for a GitHub release to publish to npm automatically. Every workspace package was private, and `@guijam/vite-plugin`'s declarations import `@guijam/contracts-ts`, which only ships TypeScript source, so no existing package could be published as is. ADR 0001 deferred the bundler choice (D-11) until the `guijam` npm package was assembled.

## Decision

- **Workflows.** `lint.yml`: Biome, build, typecheck, contracts drift, rustfmt, clippy. `test.yml`: Vitest, `cargo test`, Playwright and a package smoke test. Both run on pull requests and pushes to `main`, and both expose `workflow_call`. `release.yml` runs on `release: published`, calls both, and then publishes. `ci.yml` is gone.
- **What is published.** `guijam` (PRD §20 `packages/guijam`) with one export, `guijam/vite`. It bundles `@guijam/vite-plugin` and inlines the contract types. Its runtime dependencies (`magic-string`, `oxc-parser`) stay real dependencies, and `vite` is a peer. The CLI shim and the `@guijam/gjd-<os>-<arch>` binary packages are added when the daemon ships. The fixture and the e2e suite import `guijam/vite`, so Playwright exercises the published bundle.
- **Bundler (D-11): tsdown 0.23.7** with `dts.generator: 'oxc'`. `deps.onlyBundle: []` and `deps.onlyImport` fail the build if anything from `node_modules` is inlined, or if the output imports a package that is not declared.
- **Version source.** The release tag. `vX.Y.Z` publishes `X.Y.Z` under `latest`. `vX.Y.Z-pre` must be marked as a GitHub pre-release and publishes under `next`. The two disagreeing fails the run. The repo stays at `0.0.0`. The release job stamps `version` and `repository.url` (from `github.repository`) into the package, and drops `devDependencies` and `scripts`, which name private workspace packages.
- **Auth.** npm trusted publishing (OIDC, `id-token: write`, GitHub environment `npm`). An optional `NPM_TOKEN` secret covers the first publish only.
- **What ships is what was tested.** The job packs with pnpm (which rewrites `workspace:` ranges), runs the smoke test on that tarball, then publishes the unpacked tarball directory. A version already on npm is skipped, so a rerun is safe.
- **Node floor for development: 22.18.** tsdown and rolldown-plugin-dts require `^22.18.0`, and `.npmrc` has `engine-strict=true`. The published package keeps Vite 8's floor, `^20.19.0 || >=22.12.0`.

## Verification (2026-11-17)

| Item | Result |
|---|---|
| tsdown 0.23.7 dts on TypeScript 7.0.2 | The default generator on TS 7.0 is tsgo, which is deprecated ("upgrade to 7.1", still beta) and refuses `contracts.ts` because it sits outside the package's program. The `oxc` generator emits a self-contained `dist/vite.d.ts`. |
| `new URL('./client.js', import.meta.url)` after bundling | Kept verbatim by rolldown 1.3.2. `fixedExtension: false` keeps `.js` names. |
| `onlyBundle` / `onlyImport` guards | Probed: each fails the build with a named package. |
| Smoke test catches breakage | A tarball whose `.d.ts` imports `@guijam/contracts-ts` fails with TS2307. A tarball without `dist/client.js` fails the client check. |
| pnpm 10.10 `pack` | No `--filter` (it is not recursive), so it runs in `packages/guijam`. |
| `npm publish --dry-run` of the unpacked tarball | Ships `README.md`, `dist/{vite.js,vite.d.ts,client.js}` and a `package.json` with no `workspace:` ranges and no devDependencies. |
| npm trusted publishing docs (docs.npmjs.com/trusted-publishers, edited 2026-10-06) | Requires npm ≥ 11.5.1 (pinned 11.21.2; npm 12 needs Node ≥ 22.22.2) and Node ≥ 22.14. With `workflow_call`, the caller's filename (`release.yml`) is validated. `repository.url` must match the repository exactly. Provenance is automatic only via OIDC from a public repository. The CLI tries OIDC before falling back to a token. A trusted publisher is configured on an existing package's settings, and a new configuration expires unless it publishes within 2 days. |
| Publishing a tarball path through OIDC | Not documented, so the job publishes the unpacked directory instead. |
| Action pins | `actions/checkout@v7.0.1`, `pnpm/action-setup@v6.1.1`, `actions/setup-node@v7.1.0`, `Swatinem/rust-cache@v2.9.3`, `actions/upload-artifact@v7.0.2` are each the latest release. |

Not yet verified: a real OIDC publish and the reusable-workflow concurrency groups. Both need the GitHub repository, so the first release (a pre-release such as `v0.1.0-rc.0`) verifies them.

## Consequences

- Developers need Node 22.18 or later locally. `.nvmrc` (`22`) already resolves to it in CI.
- A release needs no version-bump commit. The npm version history lives in GitHub releases.
- `license` is `UNLICENSED` until Francis picks one. On npm that reads as "all rights reserved".
- When the daemon ships, the binary packages join this pipeline. The release job then gains a per-platform build matrix and publishes the platform packages before `guijam`.
