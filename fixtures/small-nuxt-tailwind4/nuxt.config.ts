import tailwindcss from '@tailwindcss/vite';

export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  modules: ['guijam/nuxt'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  telemetry: false,
  vite: { plugins: [tailwindcss()] },
});
