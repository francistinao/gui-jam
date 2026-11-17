#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
repo_url="git+https://github.com/francistinao/gui-jam.git"
targets=(
  darwin-arm64:aarch64-apple-darwin
  darwin-x64:x86_64-apple-darwin
  linux-x64:x86_64-unknown-linux-musl
  linux-arm64:aarch64-unknown-linux-musl
  win32-x64:x86_64-pc-windows-gnu
)

usage() {
  echo "usage: scripts/release-local.sh build <version> | publish <version> <latest|next>" >&2
  exit 2
}

[ $# -ge 2 ] || usage
command="$1"
version="$2"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || usage
out="$repo/target/release-local/$version"

build() {
  if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
    echo "Commit or stash your changes first; the release is built from HEAD." >&2
    exit 1
  fi
  rm -rf "$out"
  mkdir -p "$out"
  for entry in "${targets[@]}"; do
    platform="${entry%%:*}"
    target="${entry#*:}"
    echo "== gjd $version for $platform"
    builder=(cargo build)
    [[ $target == *-linux-* || $target == *-windows-* ]] && builder=(cargo zigbuild)
    binary=gjd
    [[ $target == *-windows-* ]] && binary=gjd.exe
    (cd "$repo" && GJD_VERSION="$version" "${builder[@]}" --release --locked -p gjd-daemon \
      --target "$target")
    REPO_URL="$repo_url" node "$repo/scripts/platform-package.mjs" "$platform" \
      "$repo/target/$target/release/$binary" "$version" "$out/platforms"
    rm -rf "$repo/target/$target"
  done

  echo "== guijam $version"
  worktree="$out/worktree"
  git -C "$repo" worktree add --detach "$worktree" HEAD > /dev/null
  (cd "$worktree" && pnpm install --frozen-lockfile > /dev/null && pnpm build > /dev/null)
  (
    cd "$worktree/packages/guijam"
    npm pkg set "version=$version" repository.type=git "repository.url=$repo_url"
    npm pkg delete devDependencies scripts
    VERSION="$version" PLATFORMS="${targets[*]%%:*}" node -e '
      const fs = require("node:fs");
      const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
      manifest.optionalDependencies = Object.fromEntries(
        process.env.PLATFORMS.split(" ").map((platform) => [
          `@guijam/gjd-${platform}`,
          process.env.VERSION,
        ]),
      );
      fs.writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    '
  )
  (cd "$worktree" && node scripts/npm-readme.mjs)
  (cd "$worktree/packages/guijam" && pnpm pack --pack-destination "$out" > /dev/null)
  git -C "$repo" worktree remove --force "$worktree"

  echo "== smoke test"
  GJD_BINARY="$out/platforms/gjd-darwin-arm64/bin/gjd" "$repo/scripts/smoke-package.sh" \
    "$out/guijam-$version.tgz"
  echo "Built guijam $version and its gjd packages in $out"
}

publish() {
  local tag="${1:-}"
  [ "$tag" = latest ] || [ "$tag" = next ] || usage
  [ -f "$out/guijam-$version.tgz" ] || { echo "Run build $version first." >&2; exit 1; }
  if ! account="$(npm whoami 2> /dev/null)"; then
    echo "Log in to npm first: npm login" >&2
    exit 1
  fi
  echo "Publishing as $account under the $tag tag"
  publish_one() {
    if [ -n "$(npm view "$1@$version" version 2> /dev/null || true)" ]; then
      echo "$1@$version is already on npm; skipping it."
      return
    fi
    npm publish "$2" --access public --tag "$tag"
  }
  for entry in "${targets[@]}"; do
    platform="${entry%%:*}"
    publish_one "@guijam/gjd-$platform" "$out/platforms/gjd-$platform"
  done
  rm -rf "$out/package"
  tar -xzf "$out/guijam-$version.tgz" -C "$out"
  publish_one guijam "$out/package"
}

case "$command" in
  build) build ;;
  publish) publish "${3:-}" ;;
  *) usage ;;
esac
