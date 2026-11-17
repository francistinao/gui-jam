import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    vite: 'src/vite.ts',
    nuxt: 'src/nuxt.ts',
    astro: 'src/astro.ts',
    client: 'src/client.ts',
    cli: 'src/cli.ts',
  },
  platform: 'node',
  dts: { generator: 'oxc', entry: ['src/vite.ts', 'src/nuxt.ts', 'src/astro.ts'] },
  fixedExtension: false,
  copy: [{ from: '../vite-plugin/dist/widget.js' }, { from: 'src/nuxt-client.mjs' }],
  deps: {
    onlyBundle: ['lucide'],
    onlyImport: ['vite', 'magic-string', 'oxc-parser', '@clack/prompts'],
  },
});
