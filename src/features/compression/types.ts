export type Preset = 'high' | 'balanced' | 'custom';
export type Strategy = 'flatten' | 'optimize';

export interface Settings {
  preset: Preset;
  strategy: Strategy;
  /** Maximum raster resolution, in DPI. */
  dpi: number;
  /** JPEG quality ceiling, 0-100. */
  jpegQuality: number;
  /** Run English OCR on pages that have no usable selectable text. */
  recognizeText: boolean;
}

/**
 * The concrete settings a job actually runs with. `resolveSettings` turns a
 * preset (`high` / `balanced`) into explicit values; `custom` passes through.
 */
export type ResolvedSettings = Settings;

export type JobStatus = 'pending' | 'processing' | 'done' | 'error' | 'cancelled';

export interface TextSummary {
  nativePages: number;
  rebuiltPages: number;
  ocrPages: number;
  imageOnlyPages: number;
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
  | {
      type: 'done';
      id: string;
      outputName: string;
      outputSize: number;
      pages: number;
      textSummary: TextSummary | null;
      opfsPath?: string;
      outputBuffer?: ArrayBuffer;
    }
  | { type: 'job-error'; id: string; message: string; stack?: string };
