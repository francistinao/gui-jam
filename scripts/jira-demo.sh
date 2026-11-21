#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
template="$repo/examples/jira-demo"

usage() {
  echo "usage: scripts/jira-demo.sh setup <new folder>" >&2
  echo "  GUIJAM_SPEC=guijam@<version> uses a published guijam instead of this checkout" >&2
  exit 2
}

[ $# -eq 2 ] && [ "$1" = setup ] || usage
target="$2"
if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "$target already exists and isn't empty." >&2
  exit 1
fi

mkdir -p "$target"
target="$(cd "$target" && pwd)"
rsync -a --exclude node_modules --exclude dist "$template/" "$target/"
printf 'node_modules/\ndist/\n.guijam/\n' > "$target/.gitignore"
printf 'minimumReleaseAge: 20160\nminimumReleaseAgeExclude:\n  - guijam\n  - "@guijam/*"\n' \
  > "$target/pnpm-workspace.yaml"

spec="${GUIJAM_SPEC:-}"
if [ -z "$spec" ]; then
  if [ ! -x "$repo/target/debug/gjd" ] || [ ! -f "$repo/packages/guijam/dist/vite.js" ]; then
    echo "Build GUIJam first: (cd $repo && cargo build -p gjd-daemon && pnpm build)" >&2
    exit 1
  fi
  rm -f "$target"/guijam-*.tgz
  pnpm -s --dir "$repo/packages/guijam" pack --pack-destination "$target" > /dev/null
  spec="file:./$(cd "$target" && ls guijam-*.tgz)"
fi

(cd "$target" && pnpm add -D "$spec" > /dev/null && pnpm install > /dev/null)

echo
echo "Demo ready in $target"
echo
if [ -z "${GUIJAM_SPEC:-}" ]; then
  echo "  cd $target && GUIJAM_GJD_BIN=$repo/target/debug/gjd pnpm dev"
  echo
  echo "  Pair (code from a ticket's GUIJam panel in Jira):"
  echo "    cd $target && GUIJAM_GJD_BIN=$repo/target/debug/gjd npx guijam jira pair <code>"
  echo "  Create the demo tickets:"
  echo "    cd $target && GUIJAM_GJD_BIN=$repo/target/debug/gjd pnpm seed:jira --project <KEY>"
else
  echo "  cd $target && pnpm dev"
  echo "  npx guijam jira pair <code>"
  echo "  pnpm seed:jira --project <KEY>"
fi
