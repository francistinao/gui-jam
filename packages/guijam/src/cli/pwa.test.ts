import { describe, expect, it } from 'vitest';
import { runsDevServiceWorker } from './pwa.js';

describe('runsDevServiceWorker', () => {
  it('spots vite-plugin-pwa with its dev service worker on', () => {
    const code = [
      "import { VitePWA as pwa } from 'vite-plugin-pwa';",
      "import { defineConfig } from 'vite';",
      'export default defineConfig(() => ({',
      "  plugins: [pwa({ registerType: 'autoUpdate', devOptions: { enabled: true } })],",
      '}));',
    ].join('\n');

    expect(runsDevServiceWorker(code)).toBe(true);
  });

  it('ignores the plugin when dev mode is off and other plugins with the same option', () => {
    const off = [
      "import { VitePWA } from 'vite-plugin-pwa';",
      'export default { plugins: [VitePWA({ devOptions: { enabled: false } })] };',
    ].join('\n');
    const other = [
      "import { other } from 'some-plugin';",
      'export default { plugins: [other({ devOptions: { enabled: true } })] };',
    ].join('\n');

    expect(runsDevServiceWorker(off)).toBe(false);
    expect(runsDevServiceWorker(other)).toBe(false);
    expect(runsDevServiceWorker('export default {')).toBe(false);
  });
});
