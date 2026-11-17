import { solidStart } from '@solidjs/start/config';
import tailwindcss from '@tailwindcss/vite';
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [guijam(), solidStart(), tailwindcss()],
});
