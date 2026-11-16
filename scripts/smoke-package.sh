#!/usr/bin/env bash
# Installs the packed `guijam` tarball into a scratch project outside the workspace and checks
# that `guijam/vite` loads, finds its browser client, and type-checks with no workspace package
# around. Without an argument it packs the current build (run `pnpm build` first).
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
"

cat > check.ts <<'TS'
import { type GuijamApi, guijam, type UpdateResult } from 'guijam/vite';
import type { Plugin } from 'vite';

export const plugin: Plugin<GuijamApi> = guijam();
export const ok: UpdateResult['status'] = 'timeout';
// Fails as an unused directive if the contract types did not ship and degraded to `any`.
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
