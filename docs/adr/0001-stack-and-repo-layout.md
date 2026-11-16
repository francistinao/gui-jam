# 0001. Stack and repository layout

- Status: accepted, amended 2026-11-17
- Date: 2026-11-17

## Context

GUIJam has TypeScript surfaces (Vite plugin, browser overlay, thin CLI) and a Rust daemon (PRD §8). Cross-process messages must be defined once (NFR-MNT-01). Phase 0 needs only the pieces the S-1 and S-3 spikes use.

Amendment (2026-11-17): D-11 is decided in 0008 (tsdown 0.23.7, used for the published `guijam` package, which raises the development Node floor to 22.18). `ci.yml` was split into `lint.yml` and `test.yml`, and `release.yml` was added.

## Decision

- **One repository, two workspaces.** pnpm 10 workspaces (`packages/*`, `fixtures/*`) and a Cargo workspace (`crates/*`, resolver 3, edition 2024).
- **Pinned toolchains and dependencies.** Node 22 (`.nvmrc`; engines `>=22.12`, the floor of Vite 8 and Vitest 5), Rust 1.97.1 (`rust-toolchain.toml`). Every dependency is pinned exactly (`.npmrc` `save-exact=true`; `=` requirements in Cargo).
- **TypeScript 7.0.2**, strict, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` (`tsconfig.base.json`).
- **Biome 2.6.8** is the one linter and formatter (Tailwind directive parsing on). **Vitest 5.1** for unit tests, **Playwright 1.65** (Chromium) for e2e. Rust: rustfmt, clippy pedantic with `-D warnings` in CI.
- **Contracts.** `contracts/*.schema.json` (JSON Schema 2020-12) are the source of truth. `contracts/codegen/generate.mjs` bundles them into one self-contained schema and writes TypeScript types (json-schema-to-typescript, checked in, drift-checked in CI). Rust types are generated at build time by typify in `crates/gjd-core/build.rs`, so they cannot drift.
- **Packages are compiled with plain `tsc`.** D-11 (tsdown vs tsup) is deferred: tsdown 0.23.7 needs Node ≥ 22.18 and is still pre-1.0, and nothing is published yet. Decide when the `guijam` npm package is assembled.
- **Process groups on Unix** through `tokio::process::Command::process_group` and `nix::sys::signal::killpg`. Windows Job Objects (P1) will use `process-wrap`, the maintained successor of `command-group`.
- **Only what the current phase uses exists.** The PRD §20 layout is the target. Crates and packages (`gjd-mcp`, `gjd-route`, `gjd-refs`, overlay, ts-worker, published wrapper) are added when their phase starts, not as empty placeholders.

## Consequences

- One `pnpm install` and one `cargo build` cover everything; CI runs the same commands as a developer (`.github/workflows/lint.yml` and `test.yml`; `scripts/gate.sh` runs them all locally).
- typify constrains how schemas are written: tagged unions must be `oneOf` branches written inline as objects with a `const` discriminator (a `$ref` per branch makes typify fall back to an untagged enum that does not enforce `kind`), and it ignores `minItems`/`maxItems`, so the daemon validates counts itself.
- Claude Code's `--json-schema` rejects a `$schema: 2020-12` declaration, so the provider-facing bundle omits `$schema` and uses only draft-07-compatible keywords (see 0004).
- The plugin package must be built before the fixture or e2e tests run (`pnpm build`; `pnpm test:e2e` does it).
