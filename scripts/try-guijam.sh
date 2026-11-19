#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
trial="vite.guijam.config.mjs"
marker=".try-guijam"
gjd="$repo/target/debug/gjd"

usage() {
  echo "usage: scripts/try-guijam.sh setup|clean <vite project directory>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
command="$1"
project="$(cd "$2" && pwd)"
exclude="$project/.git/info/exclude"

setup() {
  local config
  config="$(cd "$project" && ls vite.config.ts vite.config.mts vite.config.js vite.config.mjs 2>/dev/null | head -1 || true)"
  if [ -z "$config" ]; then
    echo "No vite.config.* in $project." >&2
    exit 1
  fi
  if [ ! -f "$repo/packages/guijam/dist/vite.js" ] || [ ! -x "$gjd" ]; then
    echo "Build GUIJam first: (cd $repo && cargo build -p gjd-daemon && pnpm build)" >&2
    exit 1
  fi
  cat > "$project/$trial" <<EOF
import { defineConfig, mergeConfig, searchForWorkspaceRoot } from 'vite';
import base from './$config';
import { guijam } from '$repo/packages/guijam/dist/vite.js';

async function withoutGuijam(option) {
  const value = await option;
  if (Array.isArray(value)) return (await Promise.all(value.map(withoutGuijam))).flat();
  return value?.name === 'guijam' ? [] : [value];
}

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  const plugins = await withoutGuijam(resolved.plugins ?? []);
  return mergeConfig({ ...resolved, plugins }, {
    plugins: [guijam()],
    server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), '$repo/packages'] } },
  });
});
EOF
  if [ ! -d "$project/.guijam" ]; then
    mkdir "$project/.guijam"
    touch "$project/.guijam/$marker"
  fi
  if [ -f "$exclude" ]; then
    for entry in "$trial" ".guijam/"; do
      grep -qxF "$entry" "$exclude" || echo "$entry" >> "$exclude"
    done
  fi
  echo "GUIJam is ready in $project (nothing tracked changed)."
  echo "Start the dev server with:"
  echo "  cd $project && GUIJAM_GJD_BIN=$gjd npx vite --config $trial"
}

clean() {
  [ -x "$gjd" ] && "$gjd" daemon stop --project "$project" >/dev/null 2>&1 || true
  rm -f "$project/$trial"
  if [ -f "$project/.guijam/$marker" ]; then
    rm -rf "$project/.guijam"
  fi
  if [ -f "$exclude" ]; then
    grep -vxF -e "$trial" -e ".guijam/" "$exclude" > "$exclude.tmp" || true
    mv "$exclude.tmp" "$exclude"
  fi
  echo "GUIJam removed from $project. Edits you applied with Use or Apply stay; see git status."
}

case "$command" in
  setup) setup ;;
  clean) clean ;;
  *) usage ;;
esac
