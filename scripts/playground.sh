#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
play="${GUIJAM_PLAYGROUND:-$HOME/Documents/personal/guijam-playground}"
node24="${GUIJAM_NODE24_BIN:-$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | tail -1)}"
only="${1:-}"

mkdir -p "$play/apps"
rm -f "$play"/guijam-*.tgz
pnpm -s --dir "$repo/packages/guijam" pack --pack-destination "$play" > /dev/null
tarball="$(ls "$play"/guijam-*.tgz)"

wanted() {
  [ -z "$only" ] || [ "$only" = "$1" ]
}

scaffold() {
  local name="$1"
  shift
  wanted "$name" || return 0
  [ -d "$play/apps/$name" ] && return 0
  echo "== scaffolding $name"
  (cd "$play/apps" && "$@")
}

scaffold sveltekit pnpm dlx sv@1.2.0 create sveltekit --template minimal --types ts \
  --add tailwindcss="plugins:none" --no-install
scaffold solid pnpm dlx create-vite@9.3.3 solid --template solid-ts --no-interactive --no-immediate
scaffold nuxt pnpm dlx nuxi@4.0.3 init nuxt --template minimal --packageManager pnpm \
  --no-install --no-gitInit
scaffold astro pnpm dlx create-astro@5.3.1 astro --template minimal --no-install --no-git \
  --no-ai --skip-houston --yes
scaffold react-router pnpm dlx create-react-router@8.5.1 react-router --yes --no-install \
  --no-git-init --no-agent-skills -v 8.5.1
scaffold next pnpm dlx create-next-app@16.4.4 next --ts --tailwind --app --use-pnpm \
  --skip-install --disable-git --no-agent-feedback --yes
if [ -n "$node24" ]; then
  scaffold solidstart env PATH="$node24:$PATH" pnpm dlx create-solid@0.12.0 \
    --project-name=solidstart --solidstart --v2 --ts --template=basic
else
  echo "== skipping solidstart: it needs Node 24 (set GUIJAM_NODE24_BIN)"
fi

for dir in "$play"/apps/*/; do
  name="$(basename "$dir")"
  wanted "$name" || continue
  echo "== preparing $name"
  path_prefix=""
  [ "$name" = solidstart ] && path_prefix="$node24:"
  if [ ! -f "$dir/pnpm-workspace.yaml" ] || ! grep -q minimumReleaseAge "$dir/pnpm-workspace.yaml"; then
    printf 'minimumReleaseAge: 20160\n' >> "$dir/pnpm-workspace.yaml"
  fi
  node "$repo/scripts/pin-mature.mjs" "$dir/package.json" guijam
  (cd "$dir" && PATH="$path_prefix$PATH" pnpm add -D "$tarball" > /dev/null)
  (cd "$dir" && PATH="$path_prefix$PATH" GUIJAM_GJD_BIN="$repo/target/debug/gjd" \
    node node_modules/guijam/dist/cli.js init --yes --skip-install --provider claude-code)
done

echo
echo "Playground ready in $play/apps. Start an app with:"
echo "  cd $play/apps/<app> && GUIJAM_GJD_BIN=$repo/target/debug/gjd pnpm dev"
