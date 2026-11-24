import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [guijam(), preact(), tailwindcss()],
});
