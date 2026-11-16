# 0003. Spike S-1: in-memory overlays through Vite, and Tailwind CSS for overlay-only classes

- Status: accepted
- Date: 2026-11-17
- Code: `packages/vite-plugin/src/`, test `tests/e2e/s1-overlays.spec.ts`

## Question

Does serving preview content from the plugin's `load` hook plus `reloadModule` deliver HMR on Vite 6 to 8 with `@vitejs/plugin-react` and Tailwind v4, including CSS for arbitrary-value classes that exist only in the preview (PRD §14.1, risk R-01)?

## Result

Yes, after two fixes. All five checks pass on **Vite 8.3.8** (plugin-react 6.3.0) and **Vite 6.4.6** (plugin-react 5.2.0), both with Tailwind 4.3.5, and passed 25 of 25 runs across five repeats on Vite 8:

1. Arbitrary classes that exist only in the overlay (`bg-[rgb(r,g,b)]`, `rounded-[Npx]`, random per run) get CSS, and the source file's bytes and mtime do not change.
2. React state survives when an overlay replaces the component's module (Fast Refresh).
3. Clearing the overlay restores the on-disk module.
4. Overlay content that does not compile returns `compile_error` attributed to the file.
5. Latency over 50 samples, each with a new arbitrary colour that needs new CSS:

| Vite | Overlay set → new style painted (p50 / p95) | Client HMR (p50 / p95) |
|---|---|---|
| 8.3.8 | 33 / 34 ms | 8 / 9 ms |
| 6.4.6 | 33 / 34 ms | 8 / 9 ms |

NFR-PERF-06 budget for a small project: p95 ≤ 300 ms. The painted time is polled once per animation frame, so it includes up to one frame of measurement granularity.

## Vite APIs used (identical on 6.4.6 and 8.3.8)

- `server.environments.client.moduleGraph.getModulesByFile / getModuleById / invalidateModule`
- `DevEnvironment.reloadModule(mod)`: this already invalidates and propagates the update (it calls Vite's internal `updateModules`), so no separate invalidation is needed for HMR.
- `DevEnvironment.transformRequest(url)` for the compile pre-flight.
- `environment.hot.send(event, data)` and `hot.on(event, listener)` with custom events typed by augmenting `vite/types/customEvent.d.ts`.
- Hook object form `transform: { order: 'pre', handler }` and `this.environment` in hooks.
- The plugin `api` field exposes `setOverlay`/`clearOverlay` (the daemon client will call these).

Not tested: Vite 8's experimental full-bundle dev mode (`DevEnvironment.bundledDev`), and Vite 7.

## Finding 1, R-01 confirmed: Tailwind ignores overlay content

`@tailwindcss/vite` 4.3.5 finds class candidates only by scanning files on disk with the Oxide scanner when the Tailwind CSS module is transformed. It rebuilds its compiler only when a build dependency's mtime changes, so content changes made in memory are never seen. Without a fix, the overlay reached the DOM but the background became transparent.

Fix, with no write to any source file and no change to the user's CSS on disk:

- An `order: 'pre'` transform appends `@source "<relative path to .guijam/run/candidates>";` to every Tailwind root stylesheet (`@import "tailwindcss"` or `@tailwind utilities`). It runs before Tailwind's own transform regardless of plugin order.
- Each overlay's text is mirrored into `.guijam/run/candidates/<path>` (git-ignored runtime data), and removed on clear.
- The plugin adds `**/.guijam/**` to `server.watch.ignored`, so Vite's watcher does not react to the mirror (or to the journal and logs later).
- When an overlay is set, the plugin reloads the Tailwind root CSS modules before the component's module. Tailwind rescans incrementally and the new utilities exist before the component renders them.

Consequence: candidates accumulate for the dev session, which is the same as Tailwind's own dev behaviour.

## Finding 2: the client cannot see compile errors reliably

When an updated module fails to compile, Vite's HMR client swallows the failed `import()`, logs "Failed to reload", and still fires `vite:afterUpdate`. The server's `vite:error` payload arrives on the WebSocket, while the HTTP 500 arrives on a different connection. In practice the 500 arrived first, so a client-side "wait one macrotask for `vite:error`" reported `ok`.

Fix: `setOverlay` pre-flights the new content with `transformRequest` (the full plugin pipeline, including import analysis) before any browser sees it. If it fails, the overlay is rolled back and the call returns `compile_error` with the real error. A broken preview never reaches the page. Cost: one extra transform per preview (milliseconds for a component), which fits inside the latency above.

## Correlation design

`setOverlay` sends `gj:update-start { updateId, urls, expectedUpdates }`, then calls `reloadModule` once per module. Each call produces exactly one `update` or `full-reload` payload. The client reports `ok` after `expectedUpdates` `vite:afterUpdate` events, `full_reload` on `vite:beforeFullReload`, `compile_error` on `vite:error`, and the server resolves `timeout` after 3 s.

## Open items (Phase 1)

- Edits written to disk by the agent (`gj_wait_for_update`, F-CORE-06) do not go through the pre-flight. They need the same server-side compile check in the plugin's `hotUpdate` path, or client-side failure detection.
- Runtime errors (module evaluation, render) after a successful update are not captured yet; the 1.5 s error window (F-CORE-06) is still to build.
- One pending update per page is assumed. A developer save that lands during a preview can be counted as one of the expected updates.
- An overlay set for a module no page has loaded yet returns `ok` immediately and does not reload CSS.
- If no browser is connected, `setOverlay` returns `timeout` after 3 s.
- The PRD puts `.guijam/` at the project root; the plugin currently uses the Vite root. These are the same in the fixture and must be reconciled when the daemon owns `.guijam/`.
