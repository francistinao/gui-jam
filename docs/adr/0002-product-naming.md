# 0002. Product naming: GUIJam everywhere

- Status: accepted
- Date: 2026-11-17

## Context

The PRD header renames the product to GUIJam (npm package `gui-jam`), but the body still uses the handoff bundle's working name, Magic Canvas, for every command, file and identifier.

## Decision

Use GUIJam for the product and for every code identifier. The PRD text stays as written; this table is the translation.

| PRD text | Code |
|---|---|
| npm `magic-canvas`, `npx magic-canvas …` | `gui-jam`, `npx gui-jam …` |
| `magicCanvas()` from `magic-canvas/vite` | `guiJam()` from `gui-jam/vite` |
| `magic-canvas.toml` | `gui-jam.toml` |
| `.magic-canvas/{run,journal,logs}` | `.gui-jam/{run,journal,logs}` |
| `~/.config/magic-canvas/config.toml` | `~/.config/gui-jam/config.toml` |
| binary `mcd` (`mcd daemon`, `mcd mcp`) | `gjd` (`gjd daemon`, `gjd mcp`) |
| crates `mcd-core`, `mcd-providers`, … | `gjd-core`, `gjd-providers`, … |
| MCP server `magic-canvas`, tools `mc_*` | `gui-jam`, `gj_*` |
| `data-mc-src` | `data-gj-src` |
| HMR events `mc:*` | `gj:*` |
| `virtual:magic-canvas/client` | `virtual:gui-jam/client` |
| keychain service `magic-canvas-figma` | `gui-jam-figma` |

## Consequences

Renaming before any code existed cost nothing. Readers of the PRD apply the table; `CLAUDE.md` repeats it for agents.
