/**
 * Storage accounting for the footer readout and the storage dialog.
 *
 * `navigator.storage.estimate()` reports the whole origin, which is more than
 * this app writes: it also covers the Pyodide / Tesseract downloads the browser
 * caches on our behalf. The app's own share (finished results in OPFS) is
 * measured directly by walking `pixelpress/jobs`, and the rest is attributed
 * from the non-standard `usageDetails` breakdown when the browser exposes it.
 */

import { isOpfsAvailable } from './opfs';

/* Same loose handle typing as `opfs.ts`: async iteration over directory entries
   is still ahead of the DOM lib types. */
type AnyDirectoryHandle = {
  entries(): AsyncIterableIterator<[string, AnyFileSystemHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<AnyDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};
type AnyFileSystemHandle = AnyDirectoryHandle & {
  kind: 'file' | 'directory';
  getFile(): Promise<File>;
};

export interface StorageUsage {
  /** Everything this origin is using, as the browser reports it. */
  usage: number;
  /** Total the browser is willing to give this origin. */
  quota: number;
  /** Finished results this app wrote to OPFS. */
  results: { bytes: number; count: number };
  /** Text recognition models (Tesseract keeps its trained data in IndexedDB). */
  models: number;
  /** Engine downloads the browser cached for us (Cache Storage). */
  engine: number;
  /** OPFS bytes outside `pixelpress/jobs`, left by an interrupted or older run. */
  strayLocal: number;
  /** Whatever the browser counts that we cannot attribute or clear ourselves. */
  other: number;
  /** False when the breakdown below `usage` is guesswork rather than reported. */
  detailed: boolean;
}

const ROOT_DIRECTORY = 'pixelpress';

async function jobsDirectory(options?: { create?: boolean }): Promise<AnyDirectoryHandle | null> {
  if (!isOpfsAvailable()) return null;
  try {
    const root = (await navigator.storage.getDirectory()) as unknown as AnyDirectoryHandle;
    const pixelpress = await root.getDirectoryHandle(ROOT_DIRECTORY, options);
    return await pixelpress.getDirectoryHandle('jobs', options);
  } catch {
    return null;
  }
}

async function directoryBytes(directory: AnyDirectoryHandle): Promise<number> {
  let bytes = 0;
  for await (const [, handle] of directory.entries()) {
    try {
      if (handle.kind === 'file') {
        bytes += (await handle.getFile()).size;
      } else {
        bytes += await directoryBytes(handle);
      }
    } catch {
      /* a folder being written by the worker right now is fine to skip */
    }
  }
  return bytes;
}

/** Bytes and job count held in `pixelpress/jobs`. */
async function measureResults(): Promise<{ bytes: number; count: number }> {
  const jobs = await jobsDirectory();
  if (!jobs) return { bytes: 0, count: 0 };

  let bytes = 0;
  let count = 0;
  try {
    for await (const [, handle] of jobs.entries()) {
      if (handle.kind !== 'directory') continue;
      count += 1;
      bytes += await directoryBytes(handle);
    }
  } catch {
    /* report what was counted before the walk failed */
  }
  return { bytes, count };
}

/** Everything in OPFS, including whatever sits outside `pixelpress/jobs`. */
async function measureLocalTotal(): Promise<number> {
  if (!isOpfsAvailable()) return 0;
  try {
    const root = (await navigator.storage.getDirectory()) as unknown as AnyDirectoryHandle;
    return await directoryBytes(root);
  } catch {
    return 0;
  }
}

export async function readStorageUsage(): Promise<StorageUsage | null> {
  if (!navigator.storage?.estimate) return null;

  const [estimate, results, localTotal] = await Promise.all([
    navigator.storage.estimate(),
    measureResults(),
    measureLocalTotal(),
  ]);

  // `usageDetails` is Chromium-only; elsewhere everything we did not measure
  // ourselves lands in "other" rather than being split into invented buckets.
  const details = (estimate as { usageDetails?: Record<string, number> }).usageDetails;
  const usage = estimate.usage ?? 0;
  const models = details?.indexedDB ?? 0;
  const engine = details?.caches ?? 0;
  const strayLocal = Math.max(0, localTotal - results.bytes);

  return {
    usage,
    quota: estimate.quota ?? 0,
    results,
    models,
    engine,
    strayLocal,
    other: Math.max(0, usage - results.bytes - strayLocal - models - engine),
    detailed: Boolean(details),
  };
}

/**
 * Deletes one job's folder, whether it holds a finished result or the partial
 * files a cancelled run left behind. The worker that was writing them has to be
 * gone first: while it still holds a sync access handle open the removal fails,
 * so a single retry covers the moment between `terminate()` and the browser
 * releasing the handle.
 */
export async function deleteStoredJob(id: string): Promise<void> {
  const jobs = await jobsDirectory();
  if (!jobs) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await jobs.removeEntry(id, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/**
 * Deletes everything this app has written to OPFS: the finished results under
 * `pixelpress`, plus any working files an interrupted run left beside them.
 * The cached engine and recognition models are deliberately left alone — they
 * are the browser's copy of a CDN download, not the user's data.
 */
export async function clearLocalFiles(): Promise<void> {
  if (!isOpfsAvailable()) return;
  try {
    const root = (await navigator.storage.getDirectory()) as unknown as AnyDirectoryHandle;
    const entries: string[] = [];
    for await (const [name] of root.entries()) entries.push(name);
    for (const name of entries) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        /* a handle another tab still holds open is fine to leave */
      }
    }
  } catch {
    /* nothing written yet, or OPFS unreadable */
  }
}
