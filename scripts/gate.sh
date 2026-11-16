#!/usr/bin/env bash
# Runs every quality gate CI runs, stopping at the first failure. Logs of the
# long-running suites land in $GATE_LOG_DIR (default: a fresh temp directory).
set -euo pipefail
cd "$(dirname "$0")/.."
log_dir="${GATE_LOG_DIR:-$(mktemp -d)}"

echo "== biome";        pnpm -s check
echo "== build";        pnpm -s build
echo "== typecheck";    pnpm -s typecheck > /dev/null
echo "== unit";         pnpm -s test > "$log_dir/unit.log" 2>&1 || { cat "$log_dir/unit.log"; exit 1; }
echo "== contracts";    pnpm -s contracts:check
echo "== package";      scripts/smoke-package.sh > "$log_dir/package.log" 2>&1 || { cat "$log_dir/package.log"; exit 1; }
echo "== rustfmt";      cargo fmt --all --check
echo "== clippy";       cargo clippy -q --workspace --all-targets -- -D warnings
echo "== cargo test";   cargo test -q --workspace > "$log_dir/cargo.log" 2>&1 || { cat "$log_dir/cargo.log"; exit 1; }
echo "== e2e";          pnpm -s test:e2e > "$log_dir/e2e.log" 2>&1 || { cat "$log_dir/e2e.log"; exit 1; }
grep -E "passed|failed" "$log_dir/e2e.log"
echo "ALL GATES PASSED"
