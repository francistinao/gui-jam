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

version="$(tar -xOzf "$tarball" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
platform_tarball=()
if [[ -n "${GJD_BINARY:-}" ]]; then
  platform_dir="$(node "$repo/scripts/platform-package.mjs" host "$GJD_BINARY" "$version" "$work/platform")"
  (cd "$platform_dir" && npm pack --silent --pack-destination "$work" > /dev/null)
  platform_tarball=("$work"/guijam-gjd-*.tgz)
fi

mkdir "$work/app"
cd "$work/app"
echo '{ "name": "guijam-smoke", "private": true, "type": "module" }' > package.json
npm install --silent --no-audit --no-fund "$tarball" ${platform_tarball[@]+"${platform_tarball[@]}"} \
  "vite@$(pin vite)" "typescript@$(pin typescript)" "@types/node@$(pin @types/node)"

printed="$(./node_modules/.bin/guijam --version)"
if [[ "$printed" != "$version" ]]; then
  echo "guijam --version printed '$printed', expected '$version'" >&2
  exit 1
fi
if ! NO_COLOR=1 ./node_modules/.bin/guijam help | grep -q 'Usage: guijam <command>'; then
  echo "guijam help did not print the usage" >&2
  exit 1
fi

if [[ ${#platform_tarball[@]} -gt 0 ]]; then
  node --input-type=module -e "
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.resolve('guijam/vite'));
const binary = require.resolve('@guijam/gjd-' + process.platform + '-' + process.arch + '/bin/gjd');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' });
if (!version.startsWith('gjd ')) throw new Error('unexpected gjd --version output: ' + version);
"
fi

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
const { withGuijam } = await import('guijam/next');
const untouched = { reactStrictMode: true };
if ((await withGuijam(untouched)('phase-production-build', {})) !== untouched) {
  throw new Error('guijam/next changed a production config');
}
const { default: astro } = await import('guijam/astro');
const integration = astro();
if (integration.name !== 'guijam' || typeof integration.hooks['astro:config:setup'] !== 'function') {
  throw new Error('guijam/astro is not an Astro integration');
}
"

cat > check.ts <<'TS'
import guijamAstro from 'guijam/astro';
import { withGuijam } from 'guijam/next';
import { type GuijamApi, guijam, type UpdateResult } from 'guijam/vite';
import type { Plugin } from 'vite';

export const plugin: Plugin<GuijamApi> = guijam();
export const integration: { name: string } = guijamAstro({ root: '.' });
export const nextConfig = withGuijam({ reactStrictMode: true });
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
