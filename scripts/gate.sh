#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
log_dir="${GATE_LOG_DIR:-$(mktemp -d)}"

echo "== biome";        pnpm -s check
echo "== build";        pnpm -s build
echo "== typecheck";    pnpm -s typecheck > /dev/null
echo "== unit";         pnpm -s test > "$log_dir/unit.log" 2>&1 || { cat "$log_dir/unit.log"; exit 1; }
echo "== contracts";    pnpm -s contracts:check
echo "== package";      { cargo build -q -p gjd-daemon && GJD_BINARY=target/debug/gjd scripts/smoke-package.sh; } > "$log_dir/package.log" 2>&1 || { cat "$log_dir/package.log"; exit 1; }
echo "== rustfmt";      cargo fmt --all --check
echo "== clippy";       cargo clippy -q --workspace --all-targets -- -D warnings
echo "== cargo test";   cargo test -q --workspace > "$log_dir/cargo.log" 2>&1 || { cat "$log_dir/cargo.log"; exit 1; }
echo "== e2e";          pnpm -s test:e2e > "$log_dir/e2e.log" 2>&1 || { cat "$log_dir/e2e.log"; exit 1; }
grep -E "passed|failed" "$log_dir/e2e.log"
start_dir=fixtures/node24/small-solidstart-tailwind4
node24="${GUIJAM_NODE24_BIN:-$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | tail -1)}"
if [ -n "$node24" ] && [ -x "$node24/node" ]; then
  echo "== node 24"
  {
    PATH="$node24:$PATH" pnpm -s --dir "$start_dir" install --frozen-lockfile &&
      PATH="$node24:$PATH" pnpm -s --dir "$start_dir" typecheck &&
      PATH="$node24:$PATH" pnpm -s exec playwright test tests/e2e/solidstart.spec.ts
  } > "$log_dir/node24.log" 2>&1 || { cat "$log_dir/node24.log"; exit 1; }
  grep -E "passed|failed" "$log_dir/node24.log"
else
  echo "== node 24 skipped: no Node 24 found, set GUIJAM_NODE24_BIN to its bin directory"
fi
echo "ALL GATES PASSED"
