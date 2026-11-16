# 0005. Daemon gateway: plugin-only WebSocket, browser traffic relayed over Vite HMR

- Status: accepted
- Date: 2026-11-17
- Code: `crates/gjd-daemon/src/{gateway,daemon,run_dir,lib}.rs`, `packages/vite-plugin/src/{daemon-client,relay}.ts`, `contracts/ws-protocol.schema.json`

## Context

PRD §19.1 has the browser widget open its own WebSocket to the daemon. For that, the plugin hands the page the daemon port and token through a virtual module, and the daemon keeps an allow-list of dev-server origins (FR-025). That design exposes a token to page JavaScript and makes the daemon reachable from the browser.

## Decision

- **Only the Vite plugin (later also the MCP shim) connects to the daemon.** It does so at `ws://127.0.0.1:<port>/ws` with `Authorization: Bearer <token>`, using Node's built-in `WebSocket` (undici accepts request headers; verified on Node 22.23).
- **Browser requests travel over Vite's existing HMR channel.** The client sends `gj:request`; the plugin admits only widget request types (`checkWidgetRequest`), forwards them, and answers the asking client with `gj:response`.
- **Gateway admission, checked before the upgrade:**
  - `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (FR-026, DNS rebinding).
  - Any `Origin` header means a browser, so the request is refused (FR-025).
  - The bearer token is compared in constant time.

  Wrong token → 401; bad Host or any Origin → 403.
- **Run files:**
  - `.guijam/run/daemon.json` holds `{pid, port, token, version, protocol}`, mode 0600, in a 0700 directory (NFR-SEC-08).
  - A `try_lock` on `.guijam/run/lock` keeps one daemon per project; a second `gjd daemon run` exits 0 with "already serves".
  - The daemon removes `daemon.json` as the last step of a clean shutdown, which is what `gjd daemon stop` waits for.
- **Lifecycle:** the plugin reads `daemon.json` (live pid) or spawns `gjd daemon run --project <root>` detached, with stderr appended to `.guijam/logs/gjd.log`, and waits up to 3 s. It reconnects with backoff from 100 ms to 5 s, and sends `plugin.hello` (with Tailwind root stylesheets) on every connect. The daemon then re-sends active overlays. The daemon exits on SIGTERM or after 30 idle minutes (D-08). The binary comes from `guijam({ daemonBinary })` or `$GUIJAM_GJD_BIN` until platform binaries are packaged; without it, fine-tune is off and the Vite log says so.
- **Writes:** one async write lock serializes commits and undos, instead of the per-file lock map in PRD §8.2. Commits are rare and take milliseconds, so parallel writes to different files (NFR-CON-01) would buy nothing yet; the journal itself is safe under concurrency.
- **Preview overlays are cleared after the rename**, not before (PRD §14.3 allows either order). Vite's reload from disk then shows the same content, so nothing flickers. On a `CONFLICT` the overlay is cleared as well, so the developer sees their own version.

## Consequences

- No browser-reachable endpoint and no token in page JS. The PRD's origin allow-list is not needed.
- Every widget message pays one extra in-process hop through the plugin (well under a millisecond on loopback).
- `tests/e2e/daemon-bridge.spec.ts` drives the real binary through the plugin: inspect, preview with the file untouched, commit (one line), undo (exact bytes), and `CONFLICT` without overwriting. `crates/gjd-daemon/tests/daemon_process.rs` covers admission, file modes, the single-instance lock, stop and the idle exit.
- Open: the published `guijam/vite` entry must also export `GuijamMessage` and `GuijamOptions`, which its public `request()` and `guijam(options)` signatures use.
