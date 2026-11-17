import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: {
      vite: 'src/vite.ts',
      nuxt: 'src/nuxt.ts',
      astro: 'src/astro.ts',
      next: 'src/next.ts',
      'next-loader': 'src/next-loader.ts',
      cli: 'src/cli.ts',
    },
    platform: 'node',
    dts: {
      generator: 'oxc',
      entry: ['src/vite.ts', 'src/nuxt.ts', 'src/astro.ts', 'src/next.ts'],
    },
    fixedExtension: false,
    copy: [{ from: '../vite-plugin/dist/widget.js' }, { from: 'src/nuxt-client.mjs' }],
    deps: {
      onlyBundle: [],
      onlyImport: ['vite', 'magic-string', 'oxc-parser', '@clack/prompts', 'ws'],
    },
  },
  {
    entry: { client: 'src/client.ts', 'next-client': 'src/next-client.ts' },
    platform: 'browser',
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { onlyBundle: ['lucide'] },
  },
]);
