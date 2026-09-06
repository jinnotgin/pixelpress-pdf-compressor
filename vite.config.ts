import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

/** Single source of truth for the app version: package.json. */
const { version: packageVersion } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * Drop trailing zero segments so the footer stays as short as the version
 * actually is: 5.0.0 -> "5", 5.1.0 -> "5.1", 5.1.2 -> "5.1.2", 5.0.3 -> "5.0.3".
 * Always keeps at least the major.
 */
function shortenVersion(version: string): string {
  const parts = version.split('.');
  while (parts.length > 1 && parts[parts.length - 1] === '0') {
    parts.pop();
  }
  return parts.join('.');
}

const appVersion = shortenVersion(packageVersion);

/**
 * Base build. Emits a normal multi-asset bundle into `dist/`.
 *
 * The PDF engine (Pyodide + PyMuPDF) and the OCR engine (Tesseract) are loaded
 * at runtime from a CDN inside the Web Worker, so they are intentionally NOT
 * part of this bundle. See `src/features/compression/config.ts`.
 */
export const baseConfig: ViteUserConfig = {
  // `/` for local dev and the single-file build; set to `/<repo>/` by the
  // GitHub Pages workflow so asset URLs resolve under the project subpath.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
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
