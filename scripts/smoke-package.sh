#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ $# -gt 0 ]]; then
  tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  pnpm -s --dir "$repo/packages/guijam" pack --pack-destination "$work" > /dev/null
  tarball="$(echo "$work"/guijam-*.tgz)"
fi

if tar -xOzf "$tarball" package/package.json | grep -q '"workspace:'; then
  echo "packed package.json still contains workspace: ranges" >&2
  exit 1
fi

listing="$(tar -tzf "$tarball")"
for shipped in package/README.md package/LICENSE package/assets/guijam-readme.jpg; do
  if ! grep -qx "$shipped" <<< "$listing"; then
    echo "the package does not ship $shipped" >&2
    exit 1
  fi
done
if tar -xOzf "$tarball" package/README.md | grep -qE '(\]\(|(src|href)=")(assets/|LICENSE)'; then
  echo "the packed README still links to files by relative path" >&2
  exit 1
fi

pin() { node -p "require('$repo/package.json').devDependencies['$1']"; }

mkdir "$work/app"
cd "$work/app"
echo '{ "name": "guijam-smoke", "private": true, "type": "module" }' > package.json
npm install --silent --no-audit --no-fund "$tarball" \
  "vite@$(pin vite)" "typescript@$(pin typescript)" "@types/node@$(pin @types/node)"

node --input-type=module -e "
import { existsSync } from 'node:fs';
const { guijam } = await import('guijam/vite');
const client = guijam().resolveId('virtual:guijam/client');
if (typeof client !== 'string' || !existsSync(client)) {
  throw new Error('browser client not found next to guijam/vite: ' + client);
}
const widget = new URL('./widget.js', import.meta.resolve('guijam/vite'));
if (!existsSync(widget)) {
  throw new Error('browser widget not found next to guijam/vite: ' + widget);
}
"

cat > check.ts <<'TS'
import { type GuijamApi, guijam, type UpdateResult } from 'guijam/vite';
import type { Plugin } from 'vite';

export const plugin: Plugin<GuijamApi> = guijam();
export const ok: UpdateResult['status'] = 'timeout';
// @ts-expect-error not a status
export const bad: UpdateResult['status'] = 'not-a-status';
TS
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false
  },
  "files": ["check.ts"]
}
JSON
./node_modules/.bin/tsc -p .

echo "guijam package OK: $(basename "$tarball")"
