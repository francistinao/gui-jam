# GUIJam

Dev-only tool that turns a running Vite app into an editable surface: draw on an element, get live variants through the developer's own LLM CLI, fine-tune, and write minimal source edits. Spec: `docs/PRD.md`. Decisions: `docs/adr/`.

## Naming (the PRD body still says magic-canvas)

| PRD text | Use in code |
|---|---|
| `magic-canvas`, `npx magic-canvas …` | `gui-jam`, `npx gui-jam …` |
| `magicCanvas()` from `magic-canvas/vite` | `guiJam()` from `gui-jam/vite` |
| `magic-canvas.toml`, `.magic-canvas/`, `~/.config/magic-canvas/` | `gui-jam.toml`, `.gui-jam/`, `~/.config/gui-jam/` |
| `mcd`, crates `mcd-*` | `gjd`, crates `gjd-*` |
| MCP server `magic-canvas`, tools `mc_*` | `gui-jam`, `gj_*` |
| `data-mc-src`, events `mc:*`, `virtual:magic-canvas/client` | `data-gj-src`, `gj:*`, `virtual:gui-jam/client` |

`docs/PRD.md` lost table cells that contained `|` inside code when it was converted. For FR-080, the §9.2 capability matrix, the §11.5 tool table, `hmr.observed` in §19.1 and the §23.1 command table, read `docs/handoff/PRD-magic-canvas.md`.

## Layout

- `contracts/*.schema.json`: source of truth for cross-process types. `pnpm contracts:gen` writes `packages/contracts-ts/src/generated/` and `contracts/generated/`; Rust types are generated at build time by `crates/gjd-core/build.rs` (typify).
- `crates/gjd-core`: contract types, content hash. `crates/gjd-providers`: provider CLI adapters. `crates/gjd-daemon`: the `gjd` binary.
- `packages/vite-plugin`: in-memory overlays served through Vite, HMR result correlation, browser client.
- `fixtures/small-react-tailwind4`: Brew & Co. test app. `tests/e2e`: Playwright.
- `docs/handoff/`: original handoff bundle (screenshots, prototype). The prototype is reference only.

## Commands

```bash
pnpm install
pnpm build                 # compile packages (fixtures consume dist/)
pnpm check                 # biome lint + format
pnpm typecheck
pnpm test                  # vitest unit tests
pnpm contracts:check       # fails if generated contracts drifted
pnpm test:e2e              # builds, then Playwright (S-1 overlay suite)
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cargo test -p gjd-providers --test live_claude_code -- --ignored --test-threads=1   # real CLI, spends tokens
cargo run -p gjd-daemon -- provider list | provider test claude-code --runs 5
```

## Rules

- Apply the engineering playbook in `skills/` (anti-slop-code, no-obvious-comments, eng-*, qa-*).
- Never trust a **[VERIFY]** item in the PRD: confirm it against the installed version (source, `--help`, a probe) and record the result in an ADR. ADR 0003 and 0004 list what has been verified.
- Never read, copy or log provider credentials or account details (PRD §10.1). Auth status comes only from the CLI's own status command or a request outcome.
- Widget-initiated provider runs never get write tools or the developer's MCP servers; edits come back as data and the daemon applies them.
- Source files are never written for previews. Only commit writes source; previews go through the Vite plugin's `load` hook.
- Pin exact versions (`.npmrc` `save-exact`, `=` in Cargo).
- Commits and PRs carry no AI attribution.
