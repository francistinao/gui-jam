# Magic Canvas — handoff bundle for Claude Code

Start here when implementing Magic Canvas.

## What's in this folder

| Path | Use |
|---|---|
| `PRODUCT_REQUIREMENTS_AND_SYSTEM_ARCHITECTURE.md` | The spec. Requirements (FR/NFR), architecture, interfaces, roadmap. Items marked **[VERIFY]** must be confirmed in the Phase 0 spikes (§25) before you build on them. |
| `screenshots/01…16-*.png` | Target UI and flow, in order. 2880×1800 (2× of 1440×900). |
| `prototype/Main.dc.html` | Source of the interactive prototype that produced the screenshots. Use it as a reference for layout, spacing, copy and interaction states. Don't use it as production code. |

## How to read the screenshots

- **Product UI:** the dark floating toolbar at the bottom right of the page (logo, Select, Draw) and the white popovers anchored next to the selected element.
- **Demo harness only, do not build:** the black strip at the top (scenario switch, step counter, Restart demo), the fake browser chrome and the terminal panel. The terminal lines show what the CLI and Vite logs should say. They aren't a UI to build.
- The popovers follow Figma UI3 styling (FigUI): 12px Inter, 28px fields with `#F5F5F5` fill and no border, a 1px `#0D99FF` focus ring on a white background, 13px popover radius with a faint double outline, `#0D99FF` primary buttons, `#F5F5F5` secondary buttons, text tabs, and preset tiles where the selected tile is filled blue.

## Flow (screenshot → step)

1. `01`–`03`: install, init, start dev server; widget appears.
2. `04`: Draw tool active.
3. `05`: mark drawn around a component → prompt popover (prompt, sketch with image attachment, design-system tiles, mode, Generate).
4. `06`: full-screen sketch over an uploaded reference image.
5. `07`: generating (progress steps).
6. `08`: three variants, live on the page; pick one.
7. `09`–`12`: fine-tune popover: Design (layout, fill, text, stroke, effects), Motion (presets, duration, curve), Code (exact before/after line).
8. `13`: applied: toast plus terminal log.
9. `14`: Select mode on a shared component (instance warning).
10. `15`–`16`: new-project scenario, fine-tune on the starter counter button.

## Constraints the prototype does NOT show but the build must follow

- Variants and unsaved tweaks live **in memory** and reach the browser through the Vite plugin's `load` hook. Nothing touches disk until Apply (spec §14). The prototype's `*.mc-v1.tsx` terminal lines are illustrative.
- The widget renders inside a **Shadow DOM** root so FigUI's global token CSS can't leak into the host app (spec §8.3).
- Live strokes are drawn on a canvas layer, not through React re-renders (spec §8.1.1).
- All writes go through the Rust daemon's commit protocol: per-file lock, hash compare-and-swap, temp file + fsync + rename, journal (spec §13.5).
- Provider credentials are never read or stored. Widget AI requests run the developer's CLI headlessly with write tools disabled (spec §9–§10).

## Suggested first task for Claude Code

Do the Phase 0 spikes S-1 (Vite overlays + Tailwind CSS generation) and S-3 (provider headless contracts) from spec §25. Then build the smallest viable slice described in Phase 1: Select → fine-tune Fill/Radius → Apply/Undo, plus Draw → prompt → one variant via Claude Code.
