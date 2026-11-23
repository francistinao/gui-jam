#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
self="$repo_dir/scripts/dependabot-gate.sh"
home="${GUIJAM_DEPENDABOT_HOME:-$HOME/.cache/guijam-dependabot}"
clone="$home/repo"
label="local.guijam-dependabot"
plist="$HOME/Library/LaunchAgents/$label.plist"
context="local-gate"

say() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

notify() {
  osascript -e "display notification \"$1\" with title \"GUIJam Dependabot\"" >/dev/null 2>&1 || true
}

usage() {
  echo "usage: scripts/dependabot-gate.sh run [--dry-run] [--force] [--pr N] | install [hour] | uninstall" >&2
  exit 2
}

compat_key() {
  local v="${1%%+*}" a b c
  case "$v" in *-*) echo "pre:$v"; return ;; esac
  IFS=. read -r a b c <<<"$v"
  if [ "${a:-0}" != 0 ]; then echo "$a"
  elif [ "${b:-0}" != 0 ]; then echo "0.$b"
  else echo "0.0.${c:-0}"; fi
}

breaking_updates() {
  local list name old new out=""
  list="$(gh pr view "$1" -R "$SLUG" --json body -q .body | tr -d '\r' |
    sed -nE 's/^(Updates `([^`]+)`|Bumps \[([^]]+)\]\([^)]*\)) from ([0-9][^ ]*) to ([0-9][^ ]*).*$/\2\3 \4 \5/p' |
    sed -E 's/\.$//')"
  if [ -z "$list" ]; then
    echo "versions not found in the PR"
    return
  fi
  while read -r name old new; do
    [ "$(compat_key "$old")" = "$(compat_key "$new")" ] || out="$out${out:+, }$name $old to $new"
  done <<<"$list"
  [ -z "$out" ] || echo "breaking: $out"
}

finish() {
  local n="$1" head="$2" main="$3" state="$4" desc="$5"
  say "#$n $state: $desc"
  [ "$DRY_RUN" = 1 ] && return
  gh api -X POST "repos/$SLUG/statuses/$head" -f state="$state" -f context="$context" -f description="${desc:0:140}" >/dev/null
  echo "$n $head $main" >>"$home/tested"
  [ "$state" = success ] || notify "#$n: $desc"
}

check() {
  local n="$1" branch head state author main log step breaking
  IFS=$'\t' read -r branch head state author <<<"$(gh pr view "$n" -R "$SLUG" --json headRefName,headRefOid,state,author -q '[.headRefName,.headRefOid,.state,.author.login]|@tsv')"
  if [ "$state" != OPEN ] || [ "$author" != app/dependabot ]; then
    say "#$n skipped: $state, opened by $author"
    return
  fi
  case "$branch" in
    dependabot/github_actions/*) say "#$n changes GitHub workflows, which only GitHub Actions can test; skipped"; return ;;
  esac
  git -C "$clone" fetch -q origin "+refs/heads/main:refs/remotes/origin/main" "+refs/pull/$n/head:refs/remotes/pr/$n"
  main="$(git -C "$clone" rev-parse refs/remotes/origin/main)"
  if [ "$(git -C "$clone" rev-parse "refs/remotes/pr/$n")" != "$head" ]; then
    say "#$n changed while checking; next run tests it"
    return
  fi
  if [ "$FORCE" != 1 ] && grep -qx "$n $head $main" "$home/tested" 2>/dev/null; then
    say "#$n already tested at ${head:0:7} on main ${main:0:7}"
    return
  fi

  log="$home/logs/pr-$n-$(date +%Y%m%d-%H%M%S).log"
  say "#$n testing ${head:0:7} merged into main ${main:0:7}; log: $log"
  git -C "$clone" checkout -q -f --detach "$main"
  git -C "$clone" clean -q -ffdx -e target/ -e node_modules/
  if ! git -C "$clone" -c user.name=dependabot-gate -c user.email=dependabot-gate@localhost merge -q --no-edit "$head" >>"$log" 2>&1; then
    git -C "$clone" merge --abort >/dev/null 2>&1 || true
    finish "$n" "$head" "$main" failure "Conflicts with main ${main:0:7}; Dependabot needs to rebase it"
    return
  fi

  if ! (cd "$clone" && pnpm install --frozen-lockfile && pnpm exec playwright install chromium && GUIJAM_E2E_RETRIES=1 scripts/gate.sh) >>"$log" 2>&1; then
    step="$(grep -E '^== ' "$log" | tail -1 | sed 's/^== //')"
    finish "$n" "$head" "$main" failure "Gate failed at ${step:-setup (install or browser download)} on main ${main:0:7}"
    return
  fi

  breaking="$(breaking_updates "$n")"
  if [ -n "$breaking" ]; then
    finish "$n" "$head" "$main" success "Gate passed on main ${main:0:7}. Not merged, $breaking"
    return
  fi
  finish "$n" "$head" "$main" success "Gate passed on main ${main:0:7}"
  [ "$DRY_RUN" = 1 ] && { say "#$n would be merged"; return; }
  if [ "$(git -C "$clone" ls-remote origin refs/heads/main | cut -f1)" != "$main" ]; then
    say "#$n passed, but main moved during the run; next run retests it"
    return
  fi
  gh pr merge "$n" -R "$SLUG" --squash --delete-branch --match-head-commit "$head"
  say "#$n merged"
  notify "#$n merged into main"
}

lock() {
  local pid
  if mkdir "$home/lock" 2>/dev/null; then
    echo $$ >"$home/lock/pid"
    return 0
  fi
  pid="$(cat "$home/lock/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  echo $$ >"$home/lock/pid"
}

run() {
  local only="" numbers n
  export DRY_RUN=0 FORCE=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --force) FORCE=1 ;;
      --pr) only="${2:?--pr needs a number}"; shift ;;
      *) usage ;;
    esac
    shift
  done
  mkdir -p "$home/logs"
  if ! lock; then
    say "another run is in progress"
    return
  fi
  trap 'rm -rf "$home/lock"' EXIT
  SLUG="$(cd "$repo_dir" && gh repo view --json nameWithOwner -q .nameWithOwner)"
  export SLUG
  [ -d "$clone/.git" ] || gh repo clone "$SLUG" "$clone" -- -q
  if [ -n "$only" ]; then
    numbers="$only"
  else
    numbers="$(gh pr list -R "$SLUG" --author app/dependabot --state open --json number -q '.[].number' | sort -n)"
  fi
  if [ -z "$numbers" ]; then
    say "no open Dependabot PRs"
    return
  fi
  for n in $numbers; do
    "$self" _check "$n" || say "#$n stopped with an error"
  done
}

install_agent() {
  local hour="${1:-22}" bin path_dirs=""
  for bin in node pnpm cargo gh git; do
    command -v "$bin" >/dev/null || { echo "$bin is not on PATH" >&2; exit 1; }
    path_dirs="$path_dirs$(dirname "$(command -v "$bin")"):"
  done
  path_dirs="${path_dirs}/usr/bin:/bin:/usr/sbin:/sbin"
  mkdir -p "$home/logs" "$(dirname "$plist")"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>$self</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path_dirs</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$hour</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$home/logs/runs.log</string>
  <key>StandardErrorPath</key>
  <string>$home/logs/runs.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  say "installed $label: runs daily at $hour:00; log: $home/logs/runs.log"
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  say "removed $label"
}

case "${1:-}" in
  run) shift; run "$@" ;;
  _check) check "$2" ;;
  install) shift; install_agent "$@" ;;
  uninstall) uninstall_agent ;;
  *) usage ;;
esac
