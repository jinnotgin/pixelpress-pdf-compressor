import { type ImageDetail, type JobStatus, type OcrLanguage } from './types';

/** Hard upload ceiling per file. */
export const MAX_FILE_BYTES = 250 * 1024 * 1024;

/** How long finished results are kept in the Origin Private File System. */
export const HISTORY_MAX_AGE_DAYS = 30;
export const HISTORY_MAX_AGE_MS = HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Plain-language explanation shown when the source file is the safest result. */
export const ORIGINAL_KEPT_WARNING =
  'PixelPress could not safely make this file smaller, so it kept the original.';

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

/** Recognition-only resolution. Large pages use overlapping tiles; OCR never
 * supplies or resizes the final page image. */
export const OCR_RENDER_DPI = 200;

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

/**
 * Rough per-unit durations, in milliseconds, used only to decide how wide each
 * stage's slice of the progress bar should be — and, for the stages that report
 * nothing while they run, how fast to animate it.
 *
 * They exist because the stages differ by orders of magnitude depending on the
 * strategy: flattening a page is expensive and preserving one is nearly free,
 * while `save()` writes to Pyodide's in-memory filesystem and costs almost
 * nothing regardless of document size (the expensive write is the OPFS copy
 * afterwards, which reports real progress of its own). Splitting the bar evenly
 * would leave whole stretches dead for one strategy and cramped for another.
 *
 * Measured in-browser against mixed, photographic and vector-heavy PDFs. They
 * only need the right order of magnitude: every band they size is either backed
 * by real progress or animated by an asymptotic ramp, so an estimate that is
 * too low stalls just short of the next stage and one that is too high arrives
 * at it early. Nothing about the output depends on them.
 */
export const STAGE_ESTIMATE_MS = {
  /** Per-page pass, by branch. Flattening rasterises; preserving copies. */
  preservePage: 30,
  flattenPage: 2500,
  ocrPage: 4000,
  /** Finalisation. */
  imagePerImage: 600,
  nativeBase: 40,
  nativePerImage: 100,
  saveBase: 25,
} as const;

/** Share of the finalisation band given to the image scan, which runs before
 * its own cost can be known. It is milliseconds of work, so it stays small. */
export const FINALIZE_SCAN_SHARE = 0.15;

/** localStorage key for the persisted settings form. */
export const SETTINGS_STORAGE_KEY = 'pixelpress-browser-settings';

/** Statuses whose jobs can be cleared / removed from the queue. */
export const REMOVABLE_STATUSES: readonly JobStatus[] = ['done', 'error'];
