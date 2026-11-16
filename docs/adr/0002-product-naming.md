# 0002. Product naming: GUIJam everywhere

- Status: accepted, amended 2026-11-17
- Date: 2026-11-17

## Context

The PRD header renames the product to GUIJam (npm package `gui-jam`), but the body still uses the handoff bundle's working name, Magic Canvas, for every command, file and identifier.

Amendment (2026-11-17): Francis chose `guijam` (no hyphen) as the package and identifier spelling, matching the GUIJam info sheet draft. The table below uses it. The short forms (`gjd`, `gj_*`, `data-gj-src`, `gj:*`) are unchanged.

## Decision

Use GUIJam for the product and for every code identifier. The PRD text stays as written; this table is the translation.

| PRD text | Code |
|---|---|
| npm `magic-canvas`, `npx magic-canvas …` | `guijam`, `npx guijam …` |
| `magicCanvas()` from `magic-canvas/vite` | `guijam()` from `guijam/vite` |
| `magic-canvas.toml` | `guijam.toml` |
| `.magic-canvas/{run,journal,logs}` | `.guijam/{run,journal,logs}` |
| `~/.config/magic-canvas/config.toml` | `~/.config/guijam/config.toml` |
| binary `mcd` (`mcd daemon`, `mcd mcp`) | `gjd` (`gjd daemon`, `gjd mcp`) |
| crates `mcd-core`, `mcd-providers`, … | `gjd-core`, `gjd-providers`, … |
| MCP server `magic-canvas`, tools `mc_*` | `guijam`, `gj_*` |
| `data-mc-src` | `data-gj-src` |
| HMR events `mc:*` | `gj:*` |
| `virtual:magic-canvas/client` | `virtual:guijam/client` |
| keychain service `magic-canvas-figma` | `guijam-figma` |

## Consequences

Renaming before any code existed cost nothing. Readers of the PRD apply the table; `CLAUDE.md` repeats it for agents.
