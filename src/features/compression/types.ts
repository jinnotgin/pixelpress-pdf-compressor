export type Preset = 'auto' | 'figma' | 'custom';
export type Strategy = 'auto' | 'flatten' | 'optimize';
export type OcrLanguage = 'eng' | 'chi_sim' | 'chi_tra' | 'msa' | 'tam';

export interface Settings {
  preset: Preset;
  strategy: Strategy;
  /** Maximum raster resolution, in DPI. */
  dpi: number;
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
 */
export type ResolvedSettings = Settings;

export type JobStatus = 'pending' | 'processing' | 'done' | 'error' | 'cancelled';

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
  | { type: 'process'; id: string; file: File; settings: ResolvedSettings }
  | { type: 'remove'; id: string };

export type WorkerOutbound =
  | { type: 'runtime'; status: RuntimeStatus; message: string; opfs?: boolean }
  | { type: 'progress'; id: string; progress: number; message: string }
  | { type: 'warning'; id: string; message: string }
  | { type: 'strategy-debug'; id: string; report: StrategyDebugReport }
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
  | { type: 'job-error'; id: string; message: string; stack?: string };
