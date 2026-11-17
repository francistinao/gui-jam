import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import guijam from 'guijam/astro';

export default defineConfig({
  integrations: [guijam(), react()],
  vite: { plugins: [tailwindcss()] },
});
