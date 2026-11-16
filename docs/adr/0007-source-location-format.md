# 0007. Source location format: `data-gj-src="<path>:<line>:<column>"`

- Status: accepted, amended 2026-11-17
- Date: 2026-11-17
- Code: `packages/vite-plugin/src/transform-srcloc.ts`

## Context

F-CORE-01 maps every rendered DOM element to the JSX element that produced it. The PRD proposes a short `fileId` resolved through a table served by the daemon, to keep attributes small. The TypeScript transform (oxc-parser npm) and the Rust patch engine (oxc crates) must agree on positions, but oxc-parser's JS API reports UTF-16 string offsets while the Rust crates report UTF-8 byte offsets.

## Decision

- The attribute value is `<path relative to the Vite root>:<line>:<column>`, for example `src/components/OrderButton.tsx:3:5`. There is no fileId table. The attribute exists only in dev, and the plain path is readable in DevTools and needs no daemon round trip or table sync.
- The position is the element's opening `<`. Lines are 1-based and split on `\n` only, so CRLF files keep `\r` at the end of the previous line. Columns are 1-based and **count UTF-16 code units**, the unit JS strings and editors use. The Rust side converts byte offsets to this convention.
- Only intrinsic elements are annotated (a JSX identifier starting with a lowercase ASCII letter). Components, member names (`motion.div`), namespaced names (`svg:rect`) and fragments are skipped. Selection falls back to the nearest annotated ancestor.
- Only files under the Vite root and outside `node_modules` are annotated; others are outside the daemon's write jail anyway.
- A file that fails to parse is passed through unchanged.
- There is no separate transform cache (F-PERF-01): Vite caches each module's transform result until the module is invalidated, which is the same key (path + content).

## Consequences

- Verified: the transform unit tests and `tests/e2e/srcloc.spec.ts` check positions after Korean text on the same line (`src/App.tsx:31:20`), with spread props, fragments and `cn()`.
- FR-022 holds: the plugin is `apply: 'serve'`, and `fixtures/small-react-tailwind4/tests/build-isolation.test.ts` asserts byte-identical builds. That test fails if `apply: 'serve'` is removed.
- Attributes are longer than a fileId would make them (around 30 bytes each). If that ever matters on large pages, the format can switch to ids without changing the Rust resolver, which only consumes `{file, line, column}`.

## Amendment (2026-11-17): polymorphic tag variables

Running the packed package in a real shadcn app showed that `Button` never got a location. It renders `<Comp>`, where `const Comp = asChild ? Slot.Root : 'button'`. Select mode then picked the nearest annotated ancestor, which was the whole header.

- A capitalized name bound by `const`/`let` to an expression that can hold a tag name is now annotated like an intrinsic element. The expression can be a lowercase string literal, or a conditional or `??`/`||` expression with one as a branch, looking through parentheses and `as`/`satisfies`/`!`. Examples: `asChild ? Slot.Root : 'button'`, `as ?? 'div'`.
- When `Comp` is the string, the DOM element gets the attribute. When it is Radix `Slot`, the attribute is merged onto the child. A child annotated in user code keeps its own location, because the child's props win the merge.
- Imported components, components declared as functions or classes, and other variables (`icons[name]`) stay unannotated.
- In shadcn, the selection is now `ui/button.tsx`. Its `className` is `cn(buttonVariants(...))`, so the panel offers Ask AI rather than fine-tune. Editing a single instance at the call site stays F-UI-09 (P2).
