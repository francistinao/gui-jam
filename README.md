# GUIJam

Point at the UI in your running Vite app, say or sketch what you want, see real variants live, keep one, polish it by hand, and the source is updated. GUIJam uses the LLM CLI you are already logged into (Claude Code, Codex CLI) and never handles provider credentials.

Status: Phase 0. The repo has the contracts, the Vite overlay plugin (spike S-1) and the Claude Code headless adapter (spike S-3). The widget, daemon gateway, MCP server and `init` are next. See `docs/PRD.md` and `docs/adr/`.

## Requirements

- Node 22.18 or later (`.nvmrc`; tsdown needs it, and `engine-strict` enforces it) and pnpm 10
- Rust 1.97.1 (installed from `rust-toolchain.toml` by rustup)
- Claude Code, logged in, for the live provider checks

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
```

## Test

```bash
pnpm check && pnpm typecheck && pnpm test && pnpm contracts:check
pnpm test:e2e
scripts/smoke-package.sh   # packs guijam, installs it outside the workspace, imports and type-checks it
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

`scripts/gate.sh` runs all of the above and stops at the first failure.

Live provider checks run the real CLI and spend tokens, so they are opt-in:

```bash
cargo run -p gjd-daemon -- provider list
cargo run -p gjd-daemon -- provider test claude-code --runs 5
cargo test -p gjd-providers --test live_claude_code -- --ignored --test-threads=1
```

## Run the fixture app

```bash
pnpm build
pnpm --filter small-react-tailwind4 dev
```

The page loads the GUIJam client (`/@id/virtual:guijam/client`). Overlays are driven through the plugin API (`setOverlay`, `clearOverlay`); see `tests/e2e/s1-overlays.spec.ts`.

## CI and releases

| Workflow | Runs on | What it does |
|---|---|---|
| `lint.yml` | pull requests, pushes to `main` | Biome lint and format, typecheck, contracts drift, rustfmt, clippy |
| `test.yml` | pull requests, pushes to `main` | Vitest, `cargo test`, Playwright, package smoke test |
| `release.yml` | a GitHub release is published | Reruns lint and test on the tag, then publishes `guijam` to npm |

To release, publish a GitHub release whose tag is `vX.Y.Z`. The tag sets the version; nothing needs to be bumped in the repo. Mark `vX.Y.Z-rc.N` tags as pre-releases: they publish under the npm dist-tag `next`, and other releases under `latest`. A tag and pre-release flag that disagree fail the run.

One-time npm setup:

1. **First publish.** npm only lets you add a trusted publisher to a package that exists. Create a granular npm access token with publish rights, store it as the `NPM_TOKEN` repository secret, and publish a pre-release such as `v0.1.0-rc.0`.
2. **Trusted publisher.** On npmjs.com, open `guijam` → Settings → Trusted publisher → GitHub Actions. Enter this repository, workflow `release.yml` and environment `npm`. Values are case-sensitive, and the configuration expires unless it publishes within 2 days.
3. **Remove the token.** Delete the `NPM_TOKEN` secret. Later releases authenticate through OIDC and get a provenance attestation, as long as the repository is public. Optionally, add required reviewers to the `npm` environment to approve each publish.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | JSON Schemas shared by every process, plus codegen |
| `crates/gjd-core` | Contract types (generated) and content hashing |
| `crates/gjd-providers` | Provider CLI adapters (Claude Code) |
| `crates/gjd-daemon` | The `gjd` binary |
| `packages/guijam` | The published npm package; `guijam/vite` bundles the Vite plugin |
| `packages/vite-plugin` | Vite plugin: in-memory overlays, HMR result correlation |
| `packages/contracts-ts` | Generated TypeScript contract types |
| `fixtures/` | Apps the tests run against |
| `tests/e2e/` | Playwright suites |
| `docs/` | PRD, ADRs, original handoff bundle |
