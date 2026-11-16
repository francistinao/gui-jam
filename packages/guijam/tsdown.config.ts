import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { vite: 'src/vite.ts', client: 'src/client.ts', cli: 'src/cli.ts' },
  platform: 'node',
  dts: { generator: 'oxc', entry: 'src/vite.ts' },
  fixedExtension: false,
  copy: [{ from: '../vite-plugin/dist/widget.js' }],
  deps: {
    onlyBundle: [],
    onlyImport: ['vite', 'magic-string', 'oxc-parser', '@clack/prompts'],
  },
});
