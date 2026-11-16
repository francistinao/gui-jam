# GUIJam

Point at the UI in your running Vite app, say or sketch what you want, see real variants live, keep one, polish it by hand, and the source is updated. GUIJam uses the LLM CLI you are already logged into (Claude Code, Codex CLI) and never handles provider credentials.

Status: Phase 0. The repo has the contracts, the Vite overlay plugin (spike S-1) and the Claude Code headless adapter (spike S-3). The widget, daemon gateway, MCP server and `init` are next. See `docs/PRD.md` and `docs/adr/`.

## Requirements

- Node 22 (`.nvmrc`) and pnpm 10
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
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

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

## Layout

| Path | What it is |
|---|---|
| `contracts/` | JSON Schemas shared by every process, plus codegen |
| `crates/gjd-core` | Contract types (generated) and content hashing |
| `crates/gjd-providers` | Provider CLI adapters (Claude Code) |
| `crates/gjd-daemon` | The `gjd` binary |
| `packages/vite-plugin` | Vite plugin: in-memory overlays, HMR result correlation |
| `packages/contracts-ts` | Generated TypeScript contract types |
| `fixtures/` | Apps the tests run against |
| `tests/e2e/` | Playwright suites |
| `docs/` | PRD, ADRs, original handoff bundle |
