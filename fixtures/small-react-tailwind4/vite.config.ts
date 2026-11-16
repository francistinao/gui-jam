import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [guijam(), react(), tailwindcss()],
});
