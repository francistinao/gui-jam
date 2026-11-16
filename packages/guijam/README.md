# guijam

Draw on your running Vite app, prompt the LLM CLI you already use, compare live UI variants, and keep the one you like as a minimal source edit.

**Status: pre-alpha.** This release contains only the Vite plugin: in-memory module overlays served through Vite, with HMR results reported back. The widget, the daemon and `npx guijam init` are not published yet.

## Install

```bash
npm i -D guijam
```

```ts
// vite.config.ts
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [guijam()],
});
```

Requirements: Node `^20.19.0 || >=22.12.0`, Vite 6, 7 or 8. GUIJam is a development tool and does nothing in production builds.
