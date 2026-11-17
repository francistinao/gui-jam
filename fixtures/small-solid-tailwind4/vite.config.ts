import tailwindcss from '@tailwindcss/vite';
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [guijam(), solid(), tailwindcss()],
});
