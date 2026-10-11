import { defineConfig } from 'vite';

// GitHub Pages serves the site from /Grid-Zero/, so production asset URLs need that prefix.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/Grid-Zero/' : '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
  },
}));
