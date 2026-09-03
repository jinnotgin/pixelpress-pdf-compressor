import PixelpressWorker from '../workers/pixelpress.worker.ts?worker&inline';

import { type WorkerInbound } from '../types';

/**
 * Spawns the PixelPress processing worker.
 *
 * The worker is bundled *inline* (embedded as a blob) rather than emitted as a
 * sibling asset, so both `npm run build` and `npm run build:single` end up with
 * no separate worker file to fetch — matching the original single-file page,
 * which also ran the worker from a blob. Pyodide and Tesseract are still pulled
 * from the CDN at runtime inside the worker.
 */
export function createPixelpressWorker(): Worker {
  return new PixelpressWorker({ name: 'pixelpress' });
}

/** Typed `postMessage` wrapper so callers can't send an unknown message shape. */
export function postToWorker(
  worker: Worker,
  message: WorkerInbound,
  transfer: Transferable[] = [],
): void {
  worker.postMessage(message, transfer);
}
