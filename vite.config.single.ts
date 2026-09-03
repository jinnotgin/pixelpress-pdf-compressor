import { defineConfig, mergeConfig, type UserConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { baseConfig } from './vite.config';

/**
 * Single-file build: `npm run build:single`.
 *
 * Re-bundles every local source file (JS, CSS, and the Web Worker) into ONE
 * self-contained `dist-single/index.html`, mirroring the original
 * `pixelpress-browser.html` distribution model.
 *
 * The Pyodide and Tesseract runtimes are still fetched from the CDN on first
 * use, exactly like the original single-file page — they are far too large to
 * inline and are cached aggressively by the browser after the first run.
 */
const singleFileConfig: UserConfig = {
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-single',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
  },
};

export default defineConfig(mergeConfig(baseConfig, singleFileConfig));
