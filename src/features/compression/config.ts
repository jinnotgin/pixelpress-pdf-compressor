import { type ImageDetail, type JobStatus, type OcrLanguage } from './types';

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

/**
 * Resolution the page is rendered at for text recognition. Fixed rather than
 * user-configurable: this is an accuracy input to Tesseract, which wants around
 * 300 DPI, not a size-versus-quality preference. The recognised image never
 * reaches the output at this resolution — the rebuilt page is downsampled to
 * the job's `flattenDpi` — so raising it costs time, not bytes.
 */
export const OCR_RENDER_DPI = 300;

/**
 * Resolution floors behind the embedded-image detail steps.
 *
 * These are floors, not destinations. The pass keeps halving while the result
 * stays strictly above the floor, then recompresses at the job's JPEG quality —
 * so every step shrinks its images, and the floor only decides how much
 * resolution is on the table. Measured against a 300 DPI source: `compact`
 * halves twice, `screen` halves once, and `print` cannot halve at all (150 is
 * not above 150), so it keeps full resolution and saves through recompression
 * alone. Values sit mid-band deliberately: 150 in the `screen` slot would land
 * on that same boundary and stop halving 300 DPI scans, the commonest input
 * there is.
 */
export const IMAGE_DETAIL_TARGETS: Record<ImageDetail, number> = {
  compact: 72,
  screen: 120,
  print: 150,
};

/** Embedded-image detail steps exposed in the settings panel, smallest first. */
export const IMAGE_DETAIL_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'screen', label: 'Screen' },
  { value: 'print', label: 'Print' },
] as const satisfies readonly { value: ImageDetail; label: string }[];

export const IMAGE_DETAIL_LABELS = Object.fromEntries(
  IMAGE_DETAIL_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<ImageDetail, string>;

/** OCR models exposed in the settings panel. */
export const OCR_LANGUAGE_OPTIONS = [
  { value: 'eng', label: 'English' },
  { value: 'chi_sim', label: 'Chinese (Simplified)' },
  { value: 'chi_tra', label: 'Chinese (Traditional)' },
  { value: 'msa', label: 'Malay' },
  { value: 'tam', label: 'Tamil' },
] as const satisfies readonly { value: OcrLanguage; label: string }[];

export const OCR_LANGUAGE_LABELS = Object.fromEntries(
  OCR_LANGUAGE_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<OcrLanguage, string>;

/** localStorage key for the persisted settings form. */
export const SETTINGS_STORAGE_KEY = 'pixelpress-browser-settings';

/** Statuses whose jobs can be cleared / removed from the queue. */
export const REMOVABLE_STATUSES: readonly JobStatus[] = ['done', 'error'];
