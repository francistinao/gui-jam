import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: { entry: 'src/widget.tsx', formats: ['es'], fileName: () => 'widget.js' },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
