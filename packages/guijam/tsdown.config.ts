import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { vite: 'src/vite.ts', client: 'src/client.ts' },
  platform: 'node',
  // oxc emits per file, so it also covers @guijam/contracts-ts sources that sit outside this
  // package's tsconfig program (tsgo refuses those, and is deprecated on TypeScript 7.0).
  dts: { generator: 'oxc', entry: 'src/vite.ts' },
  // The plugin serves the browser client from `new URL('./client.js', import.meta.url)`,
  // so both entries must be plain `.js` files side by side in dist/.
  fixedExtension: false,
  deps: {
    // Workspace packages are inlined; anything from node_modules must stay a real dependency.
    onlyBundle: [],
    onlyImport: ['vite', 'magic-string', 'oxc-parser'],
  },
});
