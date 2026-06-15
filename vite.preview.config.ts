import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

/** Standalone dev server for side-panel UI work — no extension build, Chrome APIs mocked. */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, 'src/dev'),
  publicDir: path.resolve(__dirname, 'public'),
  server: {
    port: 5173,
    // Don't pop an external browser — open via Cursor's Simple Browser instead.
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-preview'),
    emptyOutDir: true,
  },
});
