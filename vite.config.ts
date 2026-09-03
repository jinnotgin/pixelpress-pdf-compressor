import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type UserConfig } from 'vitest/config';

/**
 * Base build. Emits a normal multi-asset bundle into `dist/`.
 *
 * The PDF engine (Pyodide + PyMuPDF) and the OCR engine (Tesseract) are loaded
 * at runtime from a CDN inside the Web Worker, so they are intentionally NOT
 * part of this bundle. See `src/features/compression/config.ts`.
 */
export const baseConfig: UserConfig = {
  // `/` for local dev and the single-file build; set to `/<repo>/` by the
  // GitHub Pages workflow so asset URLs resolve under the project subpath.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
};

export default defineConfig(baseConfig);
