export type Preset = 'auto' | 'figma' | 'custom';
export type Strategy = 'auto' | 'flatten' | 'optimize';
export type OcrLanguage = 'eng' | 'chi_sim' | 'chi_tra' | 'msa' | 'tam';
export type WorkerFallback = 'skip-ocr' | 'skip-image-optimization';
/**
 * How much detail to keep in images embedded inside preserved pages. Steps
 * rather than a resolution, because the underlying pass can only halve, and
 * only acts when the result comes out smaller: what a given number produces
 * depends on the source image's resolution, encoding and content, so a DPI
 * field would promise a precision it cannot deliver. Every step recompresses;
 * they differ in how much resolution they are willing to give up. See
 * `IMAGE_DETAIL_TARGETS`.
 */
export type ImageDetail = 'compact' | 'screen' | 'print';

export interface Settings {
  preset: Preset;
  strategy: Strategy;
  /**
   * Resolution used when a whole page is turned into an image, in DPI. Applies
   * to flattened pages and to pages rebuilt around recognised text.
   */
  flattenDpi: number;
  /**
   * Detail kept in images embedded inside preserved pages. Text and vector
   * artwork on those pages stay resolution-independent, so this only bounds
   * photographs, and images already at or below the step are left untouched.
   */
  imageDetail: ImageDetail;
  /** JPEG quality ceiling, 0-100. */
  jpegQuality: number;
  /** Run OCR on pages that have no usable selectable text. */
  recognizeText: boolean;
  /** Tesseract model used when OCR is needed. */
  ocrLanguage: OcrLanguage;
}

/**
 * The concrete settings a job actually runs with. `resolveSettings` turns a
 * preset (`auto` / `figma`) into explicit values; `custom` passes through.
 * Text recognition resolution is deliberately absent: it is an accuracy input
 * rather than a preference, and lives in `OCR_RENDER_DPI`.
 */
export type ResolvedSettings = Settings;

export type JobStatus = 'pending' | 'processing' | 'done' | 'error';

export interface TextSummary {
  nativePages: number;
  rebuiltPages: number;
  ocrPages: number;
  imageOnlyPages: number;
}

export interface PageAnalysis {
  usable: boolean;
  characters: number;
  words: number;
  hidden: boolean;
  imageCoverage: number;
  contentBytes: number;
  protected: boolean;
}

export interface StrategyDebugPage {
  page: number;
  decision: 'flatten' | 'optimize';
  finalAction: 'flatten' | 'optimize' | 'ocr';
  reason: string;
  usableText: boolean;
  characters: number;
  words: number;
  largestImageCoveragePercent: number;
  contentStreamBytes: number;
  protected: boolean;
  checks: {
    imageCoverageBelow55Percent: boolean;
    contentAtLeast220KB: boolean;
    fewerThan120Words: boolean;
    contentAtLeast700KB: boolean;
  };
}

export interface StrategyDebugReport {
  requestedStrategy: Strategy;
  documentAction: 'analyze-pages' | 'keep-original';
  documentReason: string;
  documentFeatures: {
    signed: boolean;
    forms: boolean;
    annotations: boolean;
    links: boolean;
    tagged: boolean;
  };
  thresholds: {
    maximumImageCoverage: number;
    likelyVectorContentBytes: number;
    likelyVectorMaximumWords: number;
    definiteVectorContentBytes: number;
  };
  pages: StrategyDebugPage[];
}

/**
 * What the image pass found, reported once per job so real inputs can be
 * measured rather than guessed at. `unreached` counts images that are drawn but
 * carry no xref to rewrite — inline images, plus the annotation appearances
 * that `annotations` counts separately and the pass does reach.
 */
export interface ImageDebugReport {
  planned: number;
  rewritten: number;
  annotations: number;
  unreached: number;
}

export interface Job {
  id: string;
  name: string;
  originalSize: number;
  settings: ResolvedSettings;
  status: JobStatus;
  progress: number;
  message: string;
  /** Present until the job finishes; absent for history entries restored from OPFS. */
  file?: File;
  warning?: string;
  textSummary?: TextSummary | null;
  outputName?: string;
  outputSize?: number | null;
  /** Path inside the Origin Private File System, when the result was persisted there. */
  opfsPath?: string | null;
  /** In-memory object URL, when the result came back as a transferable buffer. */
  downloadUrl?: string | null;
  completedAt?: number;
  /** True when no smaller safe result was found and the source bytes were retained. */
  usedOriginal?: boolean;
  /** One-time safety fallbacks already applied after a fatal PDF-engine trap. */
  workerFallbacks?: WorkerFallback[];
}

export type RuntimeStatus = 'loading' | 'ready' | 'error';

export interface RuntimeState {
  status: RuntimeStatus;
  message: string;
  opfs: boolean;
}

export interface Notice {
  kind: 'error' | 'warning';
  text: string;
}

/* --- Worker message protocol ------------------------------------------------ */

export type WorkerInbound =
  | {
      type: 'process';
      id: string;
      file: File;
      settings: ResolvedSettings;
      fallbacks?: WorkerFallback[];
    }
  | { type: 'remove'; id: string };

export type WorkerOutbound =
  | { type: 'runtime'; status: RuntimeStatus; message: string; opfs?: boolean }
  | { type: 'progress'; id: string; progress: number; message: string }
  | {
      // A stage the worker cannot report from within: the UI thread animates
      // `from` towards `to` over `etaMs` until the next real message arrives.
      type: 'progress-estimate';
      id: string;
      from: number;
      to: number;
      etaMs: number;
      message: string;
    }
  | { type: 'warning'; id: string; message: string }
  | { type: 'strategy-debug'; id: string; report: StrategyDebugReport }
  | { type: 'image-debug'; id: string; report: ImageDebugReport }
  | {
      type: 'done';
      id: string;
      outputName: string;
      outputSize: number;
      pages: number;
      textSummary: TextSummary | null;
      usedOriginal: boolean;
      opfsPath?: string;
      outputBuffer?: ArrayBuffer;
    }
  | {
      type: 'job-error';
      id: string;
      message: string;
      stack?: string;
      fallback?: WorkerFallback;
    };
