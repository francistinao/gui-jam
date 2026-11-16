# 0004. Spike S-3: provider CLI headless contracts

- Status: accepted for Claude Code; Codex open; Hermes MCP-only
- Date: 2026-11-17
- Code: `crates/gjd-providers/src/`, `crates/gjd-daemon/src/main.rs`; recordings in `crates/gjd-providers/tests/fixtures/`

## Question

What are the exact flags for structured output, tool restriction, images and auth failures, and what is the cold-start cost, for each provider CLI (PRD §9.2–§9.4, §10.3, risks R-02 and R-03)?

## Claude Code 2.1.325: verified

Invocation used by the adapter for every widget run:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode dontAsk --no-session-persistence --strict-mcp-config \
  --json-schema '<variant-set.provider.schema.json>' \
  --append-system-prompt '<system prompt>' \
  --tools ''                 # R1;  --tools 'Read,Grep,Glob' for R2
  [--model haiku|sonnet|opus|fable]
```

The prompt goes to stdin as one stream-json user message, with images as base64 content blocks.

| PRD assumption | Verified behaviour |
|---|---|
| `--output-format json --json-schema` returns `structured_output` | Confirmed, in both `json` and `stream-json`. The CLI validates against the schema. |
| JSON Schema 2020-12 accepted | **Corrected.** `--json-schema` rejects `"$schema": ".../draft/2020-12/schema"` ("no schema with key or ref"). Union `type` arrays print an Ajv strict-mode warning. The provider bundle omits `$schema` and uses `oneOf` instead of type arrays. |
| `--allowedTools` + `--permission-mode dontAsk` block writes | **Improved.** `--tools` sets which built-in tools exist at all (`""` = none). Live test: a read-only run told to overwrite, delete and create files left the project unchanged. |
| No `--bare`, so the user's MCP servers (e.g. Figma) are available | **Corrected for widget runs.** The developer's MCP servers stay callable unless `--strict-mcp-config` is passed, including any MCP tool allow-listed in their own settings, which `dontAsk` would then permit. Widget runs pass `--strict-mcp-config`. R3/Figma runs will pass an explicit `--mcp-config`. |
| `--append-system-prompt-file` | Works, but is not listed in `--help` (only mentioned under `--bare`). The adapter uses `--append-system-prompt`. |
| Auth status command unknown | `claude auth status --json` → `{"loggedIn": bool, …}`, exit 0 even when logged out. The report also includes email, org and plan, which the adapter does not deserialize. |
| Login command `claude` then `/login` | **Corrected:** `claude auth login`. |
| Auth failure → `system/api_retry` with `authentication_failed` | **Corrected.** No retry events on 401. The stream has `assistant.error = "authentication_failed"`, `api_error_status: 401`, then a `result` with **`subtype: "success"` but `is_error: true`**, and the process exits 1. Classify on `is_error` and `api_error_status`, never on `subtype`. |
| Image input via stream-json | Confirmed: a base64 PNG content block was described correctly. |
| SIGINT for clean cancel | Confirmed: SIGINT to the process group left no survivors (`pgrep`) after **1.25 s** (FR-056: ≤ 3 s). |
| Model aliases | `haiku`, `sonnet`, `opus`, `fable` per `--help`. `haiku` resolved to `claude-haiku-5-5`. |

Status codes 429 → `RateLimited` and 529 → `Overloaded` are mapped from the Anthropic API's documented codes; they were not reproduced live.

### Timings (MacBook, arm64, `gjd provider test claude-code --runs 5`, haiku)

| Measure | p50 | p95 |
|---|---|---|
| Spawn → `system/init` (cold start), `--strict-mcp-config` | 315 ms | 320 ms |
| Spawn → `system/init`, developer's 29 MCP servers loaded | 782 ms | — |
| Spawn → trivial answer parsed | 1837 ms | 1981 ms |
| Realistic R1 request (OrderButton, 3 variants) | 23.3 s (1 run) | — |

The CLI keeps running about **1.4 s after it prints `result`** before it exits. The adapter returns as soon as the `result` event is parsed and reaps the process in the background, with a 10 s grace period before the SIGINT/SIGTERM/SIGKILL escalation. The realistic request is dominated by model generation of three variants with rationales; prompt and variant budget tuning belong to Phase 1 (R-11).

Other observations:
- `hooks` from the developer's own settings still run (we do not use `--bare`, which would skip OAuth login).
- `system/init` carries `cwd`, memory paths and MCP server names, so it must never be logged verbatim. Recorded fixtures keep only the fields the parser reads.

## Codex CLI: not verified

Codex was not installed when the spike ran, so no Codex adapter exists yet. Every Codex row in PRD §9.2 stays **[VERIFY]** (`exec --json`, `--sandbox read-only`, `--output-schema`, `--output-last-message`, `-m`, `--image`, `codex login status`, `codex mcp add`). Next step: install, log in, and repeat this spike with `crates/gjd-providers/tests/live_claude_code.rs` as the template.

## Hermes Agent 0.18.2: help output only, no tokens spent

- Headless: `hermes -z PROMPT` (`--oneshot`) prints only the final text, loads tools as normal, and **auto-bypasses approvals**. `hermes chat -q QUERY` supports `--image PATH`. `-t TOOLSETS` limits toolsets. `--usage-file PATH` writes a JSON usage report.
- No structured-output flag and no machine-readable event stream.
- MCP: `hermes mcp add NAME --command CMD --args …` registers stdio servers, which answers the PRD §11.3 [VERIFY] for `init`.
- Decision D-01 stands: Hermes is MCP-only for MVP. Widget runs would need JSON extraction plus a verified toolset with no write tools, and one-shot mode bypasses approvals.

## Consequences

- `ProviderAdapter` implements `discover`, `check_auth`, `capabilities` and `generate` with a cancellation token. Progress events (`generate.progress`) and MCP registration come with the daemon gateway; the stream shapes they need are recorded above.
- Offline tests replay recorded streams (success, invalid credentials) plus synthetic cases. Live tests are `#[ignore]`d and run on request.
