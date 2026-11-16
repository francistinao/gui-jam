import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The widget is one self-contained ES module served to the page by the Vite plugin.
// React is bundled in (the host app may use another copy or none), and production
// React keeps it small.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: { entry: 'src/widget.tsx', formats: ['es'], fileName: () => 'widget.js' },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
