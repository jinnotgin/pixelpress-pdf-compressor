import { type JobStatus } from './types';

/** Hard upload ceiling per file. */
export const MAX_FILE_BYTES = 250 * 1024 * 1024;

/** How long finished results are kept in the Origin Private File System. */
export const HISTORY_MAX_AGE_DAYS = 30;
export const HISTORY_MAX_AGE_MS = HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Streaming chunk size for OPFS / WORKERFS reads and writes. */
export const OPFS_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Heavy runtimes, fetched from a CDN on first use inside the worker (never
 * bundled). Pin exact versions so a CDN-side major bump can't break the app.
 */
export const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/';
export const PYODIDE_MODULE_URL = 'https://cdn.jsdelivr.net/npm/pyodide@314.0.6/pyodide.mjs';
export const TESSERACT_MODULE_URL =
  'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';

/** localStorage key for the persisted settings form. */
export const SETTINGS_STORAGE_KEY = 'pixelpress-browser-settings';

/** Statuses whose jobs can be cleared / removed from the queue. */
export const REMOVABLE_STATUSES: readonly JobStatus[] = ['done', 'error', 'cancelled'];
