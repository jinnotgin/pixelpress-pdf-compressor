/**
 * Storage accounting for the footer readout and the storage dialog.
 *
 * The split the dialog draws is the one the browser actually supports: what
 * this app wrote is measured directly by walking OPFS, and everything else is
 * the remainder of `navigator.storage.estimate()`. That remainder covers the
 * Pyodide and Tesseract downloads the browser cached on our behalf plus
 * anything else the origin holds, none of which this app can delete.
 *
 * It is deliberately not split further. The old breakdown leaned on the
 * Chromium-only `usageDetails`, and even there it under-reported: Pyodide's
 * wheels are ordinary HTTP fetches, so they never appear in `usage` at all. One
 * honest remainder beats four buckets that only add up on one browser.
 */

import { HISTORY_MAX_AGE_MS } from '../config';

import {
  directoryBytes,
  openJobsDirectory,
  openOpfsRoot,
  scanJobFolders,
} from './job-folders';

export interface StorageUsage {
  /** Everything this origin is using, as the browser reports it. */
  usage: number;
  /** Total the browser is willing to give this origin. */
  quota: number;
  /** What this app wrote, all of it in OPFS and all of it deletable from here. */
  app: {
    /** `results.bytes + working.bytes`, measured rather than summed. */
    total: number;
    /** Finished results with a download still attached. */
    results: { bytes: number; count: number };
    /** Staged inputs and partial output from runs that did not finish. */
    working: { bytes: number; count: number };
  };
  /** Cached engine and model downloads, and any other data the origin holds. */
  external: number;
}

/** Everything in OPFS, jobs folder or not. */
async function measureLocalTotal(): Promise<number> {
  const root = await openOpfsRoot();
  if (!root) return 0;
  try {
    return await directoryBytes(root);
  } catch {
    return 0;
  }
}

/**
 * Splits the app's own bytes into results and working files.
 *
 * `working` is derived by subtraction so the two rows always add up to what is
 * really on disk: anything outside `pixelpress/jobs`, from an older layout or a
 * write we do not know about, lands there rather than going unaccounted for.
 * Expired folders count as working files too — they are deleted on the next
 * startup, but they are occupying the disk right now.
 */
async function measureApp(): Promise<StorageUsage['app']> {
  const [total, scan] = await Promise.all([
    measureLocalTotal(),
    scanJobFolders(Date.now() - HISTORY_MAX_AGE_MS),
  ]);

  let resultBytes = 0;
  let resultCount = 0;
  let workingCount = 0;
  for (const folder of scan?.folders ?? []) {
    if (folder.kind === 'result') {
      resultBytes += folder.bytes;
      resultCount += 1;
    } else {
      workingCount += 1;
    }
  }

  return {
    total,
    results: { bytes: Math.min(resultBytes, total), count: resultCount },
    working: { bytes: Math.max(0, total - resultBytes), count: workingCount },
  };
}

export async function readStorageUsage(): Promise<StorageUsage | null> {
  if (!navigator.storage?.estimate) return null;

  const [estimate, app] = await Promise.all([navigator.storage.estimate(), measureApp()]);

  const usage = estimate.usage ?? 0;
  return {
    usage,
    quota: estimate.quota ?? 0,
    app,
    // Quota accounting lags our own writes, so mid-run the estimate can read
    // lower than the bytes we just counted ourselves.
    external: Math.max(0, usage - app.total),
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
  const jobs = await openJobsDirectory();
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
  const root = await openOpfsRoot();
  if (!root) return;
  try {
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
