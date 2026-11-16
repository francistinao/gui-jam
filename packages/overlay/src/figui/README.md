# Vendored FigUI

Figma UI3 components from [anxndsgn/FigUI](https://github.com/anxndsgn/FigUI) (MIT, see `LICENSE`), copied at commit `559806bf6263` as the project intends ("copy into your codebase", PRD §8.3).

Changes from upstream:

- `figui.css`: the `:root` token block also targets `:host`, because custom properties on `:root` do not apply inside the widget's Shadow DOM.
- Imports point at `./cn` instead of `@/lib/utils`.
- `color-chit.tsx` takes a ready CSS colour instead of parsing one with `chroma-js` (the panel validates hex itself, FR-061), so `chroma-js` is not a dependency.
- `numeric-input.tsx` drops the arithmetic-expression evaluator; values are clamped by `NumberField`.
- Types are tightened for this repo's strict TypeScript settings.

Only the components the widget uses are copied.
