import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [guijam(), vue(), tailwindcss()],
});
