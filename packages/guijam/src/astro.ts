import { fileURLToPath } from 'node:url';
import { type GuijamOptions, guijam } from '@guijam/vite-plugin';

export interface AstroSetup {
  command: 'dev' | 'build' | 'preview' | 'sync';
  config: { root: URL };
  updateConfig: (config: { vite: { plugins: unknown[] } }) => unknown;
  injectScript: (stage: 'page', content: string) => void;
}

export interface AstroIntegrationLike {
  name: string;
  hooks: { 'astro:config:setup': (setup: AstroSetup) => void };
}

export default function guijamAstro(options: GuijamOptions = {}): AstroIntegrationLike {
  return {
    name: 'guijam',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig, injectScript }) => {
        if (command !== 'dev') return;
        updateConfig({
          vite: { plugins: [guijam({ root: fileURLToPath(config.root), ...options })] },
        });
        injectScript('page', "import 'virtual:guijam/client';");
      },
    },
  };
}
