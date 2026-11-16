<p align="center">
  <img src="assets/guijam-readme.jpg" alt="GUIJam" width="560" />
</p>

<p align="center">
  <strong>Draw on your running app. Get live UI variants. Keep the one you like as a real source edit.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/guijam"><img src="https://img.shields.io/npm/v/guijam?color=0d99ff&label=npm" alt="npm version" /></a>
  <a href="https://github.com/francistinao/gui-jam/actions/workflows/test.yml"><img src="https://github.com/francistinao/gui-jam/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="MIT license" /></a>
</p>

---

## Introduction

GUIJam turns the app running in your Vite dev server into an editable canvas. Point at an element, circle it, or sketch what you want, describe the change in plain words, and GUIJam previews it live in the page before anything touches your files. When you keep a change, it lands as a minimal edit in the component that renders it, with one-click undo.

GUIJam drives the AI coding CLI you already use and are logged into, such as Claude Code. There are no API keys to configure and no credentials leave your machine. Everything runs only in development: production builds are byte-for-byte the same with or without it.

## Quick start

Install it as a dev dependency:

```bash
npm i -D guijam
```

Add the plugin to `vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [guijam(), react(), tailwindcss()],
});
```

Start your dev server as usual:

```bash
npm run dev
```

The GUIJam toolbar appears at the bottom right of your page.

| Tool | What to do |
|---|---|
| **Select** | Click any element. Tweak its fill and corner radius in a Figma-style panel, then **Apply**. |
| **Draw** | Circle an element and describe the change. Pick one of three live variants and **Use** it. |
| **Draw** (sketch) | Sketch a card, a section or an icon where you want it. GUIJam works out the component and where it goes. |
| **Ask** | Ask a question about what you see, such as "what's the path of this image?" |

Every applied change shows an **Undo** for 10 seconds, and `Alt+Shift+M` hides the toolbar.

### Requirements

- Node `^20.19.0` or `>=22.12.0`, on macOS or Linux
- Vite 6, 7 or 8, with React and Tailwind CSS
- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your `PATH`)

### Pages rendered by a backend

With Laravel's `@vite` directive, Inertia, or any server that renders the HTML itself, Vite never sees an `index.html`. GUIJam then loads from the script entries in `build.rollupOptions.input`, which `laravel-vite-plugin` already sets. No extra setup is needed.

## Core features

- **Source-mapped elements.** Every element knows the file, line and column of the JSX that rendered it, including polymorphic components such as `asChild` buttons.
- **Live previews, never written early.** Previews are served from memory through Vite's module graph and hot reload, so switching between variants never changes a file on disk.
- **Fine-tune like a design tool.** The panel adapts to the element's real Tailwind classes, prefers your theme tokens, and writes a one-line change.
- **Three variants per request.** One call to your CLI returns three takes on the request, with live progress while it works.
- **Exact edits without AI.** Prompts like "make it blue and pill-shaped" become a precise edit instantly, with no model call. Ask for AI variations when you want them.
- **Answers, not just edits.** Ask about an element and get an answer that points at the files involved.
- **References across the page.** "Use the image from the navbar here" works, because GUIJam indexes your project's assets and the page you are looking at.
- **Sketch to UI.** Rough out a layout or an icon. GUIJam sends the sketch and a screenshot of the page, then places the new markup in the right component.
- **Generated icons.** Icons drawn from your sketches are saved as lightweight SVG, or WEBP when a raster image fits better.
- **Safe writes.** Edits are journaled with the exact previous bytes, conflicts with your own unsaved work are refused, and undo restores files exactly.
- **Your CLI, your login.** GUIJam runs the provider CLI headlessly with no write tools and never reads its credentials.

## Architecture

```
 Browser                       Vite dev server                 gjd daemon (Rust)               Provider CLI
┌──────────────────┐  HMR   ┌────────────────────────┐   WS    ┌───────────────────────┐ stdio ┌──────────────┐
│ GUIJam widget    │◀──────▶│ guijam() plugin        │◀───────▶│ inspect · patch ·     │◀─────▶│ Claude Code  │
│ in a shadow root │        │ source locations,      │  token  │ journal · routing ·   │       │ (headless)   │
└──────────────────┘        │ in-memory previews     │         │ providers             │       └──────────────┘
                            └────────────────────────┘         └───────────────────────┘
```

- **The widget** lives in a shadow root, so your app's styles never leak into it and its styles never leak out. It talks only to the Vite dev server, over the existing hot-reload channel.
- **The Vite plugin** adds source locations to JSX elements, serves previews from memory in place of the files on disk, and reports whether each hot update succeeded.
- **The `gjd` daemon** is the only process that writes to your project. It reads the element's source, routes each request, runs your CLI, validates every proposed edit against the current file, and journals each commit for undo. It listens on localhost only and requires a per-session token.
- **Your CLI** receives the relevant code inline and answers with structured edits. It is never given tools that can change files.

## Development

Requirements: Node 22.18 or later, pnpm 10, and Rust (the pinned toolchain in `rust-toolchain.toml` is installed by rustup).

```bash
git clone https://github.com/francistinao/gui-jam.git
cd gui-jam
pnpm install
pnpm exec playwright install chromium
cargo build -p gjd-daemon
pnpm build
```

Run the example app against your own checkout:

```bash
GUIJAM_GJD_BIN=$PWD/target/debug/gjd pnpm --filter small-react-tailwind4 dev
```

Run every check the CI runs, stopping at the first failure:

```bash
scripts/gate.sh
```

| Path | What it is |
|---|---|
| `packages/guijam` | The published package; `guijam/vite` bundles the plugin |
| `packages/vite-plugin` | Vite plugin: source locations, in-memory previews, hot-update tracking |
| `packages/overlay` | The browser widget (React in a shadow root) |
| `packages/contracts-ts` | TypeScript types generated from `contracts/` |
| `contracts/` | JSON Schemas shared by every process |
| `crates/gjd-core` | Source inspection, the patch engine and the journal |
| `crates/gjd-providers` | Provider CLI adapters |
| `crates/gjd-daemon` | The `gjd` binary |
| `fixtures/` | Apps the tests run against |
| `tests/e2e/` | Playwright suites |

### Releasing

Publish a GitHub release tagged `vX.Y.Z`. CI runs every check on the tag, then publishes `guijam@X.Y.Z` to npm. Tags such as `vX.Y.Z-rc.N`, marked as pre-releases, publish under the `next` dist-tag.

## Credits

- [FigUI](https://github.com/anxndsgn/figui) by anxndsgn (MIT), the Figma-style components the widget is built from
- [Base UI](https://base-ui.com), [React](https://react.dev) and [Tailwind CSS](https://tailwindcss.com)
- [Vite](https://vite.dev) and the [oxc](https://oxc.rs) parser
- [Tokio](https://tokio.rs) and [axum](https://github.com/tokio-rs/axum)
- [Claude Code](https://claude.com/claude-code), the CLI GUIJam drives

## License

[MIT](LICENSE)

<p align="center">Made with ♥ by Francis</p>
