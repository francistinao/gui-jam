# 0006. Adaptive fine-tune panel and the first AI route (R1)

- Status: accepted
- Date: 2026-11-17
- Code: `crates/gjd-core/src/{style,tailwind,codemod,patch}.rs`, `crates/gjd-daemon/src/{daemon,generate}.rs`, `packages/overlay/src/`

## Context

The PRD's fine-tune popover (FR-060 to FR-067) lists fixed sections: fill, stroke, radius, effects, text. Francis asked for the panel to follow the element's real classes instead, the way Figma shows only the properties a layer has. The first Phase 1 slice also needs one AI path (Draw → prompt → one variant) to prove the provider contract end to end.

## Decision

**Fine-tune is built from the element's source.**

- `element.inspect` parses the element's `className` with oxc and classifies each Tailwind token into a group: fill, radius, stroke, text, effects, opacity. Tokens outside these groups (spacing, layout) are not shown.
- Groups appear in Figma UI3 order. A group the element uses opens pre-filled and labelled with its theme token, for example `brand` or `lg`. A writable group the element does not use appears as a "+" row. Text is hidden for elements that cannot hold text (`img`, `input`, `svg` and so on).
- This slice writes fill and radius. Other groups the element uses are shown read-only.
- Tokens behind a variant (`hover:`, `md:`), tokens in a conditional `cn()` argument, and a `className` computed at runtime are read-only, with Ask AI offered instead.
- Edits become one `class_tokens` op. It removes the group's base tokens and puts the new token where the first one was, so class order is kept. A theme token is preferred when its value matches exactly (FR-067).
- Values shown come from source (the token's theme value, then any `/NN` opacity modifier). The computed style is the fallback, because the page may still be catching up after Apply or Undo.
- Apply commits the preview of the last edit. It waits for a preview in flight, so a developer edit made in between is reported as `CONFLICT` and never silently rebased.

**Draw → prompt → one variant goes through route R1 only.**

- A stroke selects an element by a pure hit-test (FR-030), using five sample points:
  - First choice: the largest annotated element the stroke mostly encloses (≥ 60 % of it inside the stroke's box).
  - Otherwise: the smallest element that mostly covers the stroke.
  - A tap picks the element under it.
- The daemon inlines ±40 numbered lines, the element's position, `base_hash`, its class source and the theme tokens. It runs Claude Code with the `haiku` alias, a 60 s timeout, `--tools ""` and `--strict-mcp-config`.
- The answer must be one variant with 1 to 40 ops, all in the shown file. The daemon applies the ops to the file as it is now, so a save made while the model worked becomes `STALE_BASE`. It then previews the variant as an overlay, which Use commits like any fine-tune change.
- `generate.cancel` reaches the provider's process group through the existing `ProviderProcess::terminate`. A reply that arrives for a cancelled run is discarded by the widget.
- Provider failures map to the PRD §19.6 codes. `PROVIDER_TIMEOUT`, `PROVIDER_FAILED` and `CANCELLED` are additions. Login status is checked through `claude auth status` at most every 5 minutes, and again after any authentication failure.
- Generation requests get a longer reply window (90 s at the plugin, 95 s in the browser). Other requests keep 15 s and 20 s.

## Consequences

- e2e uses `tests/fake-cli/claude`, a stand-in that answers in Claude Code's stream-json shape. It is put first on the `PATH` the daemon inherits, so runs are deterministic and cost nothing. It also logs its arguments, which lets the e2e assert that widget runs offer no tools.
- R0 (prompts parsed as property changes), R2/R3, multiple variants, progress events and Codex are not built yet. Codex waits for its S-3 spike.
- Unused groups this build cannot write are not offered as "+" rows. Offering them as Ask AI shortcuts is a later step.
