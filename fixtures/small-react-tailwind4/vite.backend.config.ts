import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { guijam } from 'guijam/vite';
import { defineConfig } from 'vite';

// The fixture as a backend-integrated app (Laravel, Inertia): another server renders
// the HTML and loads the entry named here straight from Vite, so index.html is unused.
export default defineConfig({
  plugins: [guijam(), react(), tailwindcss()],
  build: { rollupOptions: { input: 'src/main.tsx' } },
});
