import { fileURLToPath } from 'node:url';
import { type GuijamOptions, guijam } from '@guijam/vite-plugin';

interface NuxtOptions {
  dev: boolean;
  rootDir: string;
  plugins: unknown[];
  vite: { plugins?: unknown[] };
}

export interface NuxtLike {
  options: NuxtOptions;
}

const CLIENT_PLUGIN = fileURLToPath(new URL('./nuxt-client.mjs', import.meta.url));

function guijamNuxt(options: GuijamOptions | undefined, nuxt: NuxtLike): void {
  if (!nuxt.options.dev) return;
  nuxt.options.vite.plugins = [
    ...(nuxt.options.vite.plugins ?? []),
    guijam({ root: nuxt.options.rootDir, ...options }),
  ];
  nuxt.options.plugins.push({ src: CLIENT_PLUGIN, mode: 'client' });
}

guijamNuxt.meta = { name: 'guijam', configKey: 'guijam' };

export default guijamNuxt;
