import { defineConfig } from 'vite';

// GitHub Pages serves the site from /Grid-Zero/, so production asset URLs need that prefix.
// `vite preview` serves the production build, so it needs the same prefix.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/Grid-Zero/' : '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
  },
}));
