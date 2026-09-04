import { HISTORY_MAX_AGE_MS } from '../config';
import { type Job } from '../types';
import { DEFAULT_SETTINGS } from '../utils/settings';
import { formatTextSummary } from '../utils/text-summary';
import { isOpfsAvailable } from './opfs';

interface StoredMetadata {
  originalName?: string;
  outputName?: string;
  originalSize?: number;
  size?: number;
  opfsPath?: string;
  completedAt?: number;
  settings?: Partial<Job['settings']>;
  textSummary?: Job['textSummary'];
  usedOriginal?: boolean;
}

/**
 * Reads back finished jobs written to OPFS by earlier sessions and deletes
 * anything past the retention window. Recent folders without metadata belong to
 * a run that is still in flight (or was interrupted), so they are left alone
 * rather than pulled out from under another tab.
 */
export async function restoreOpfsHistory(): Promise<Job[]> {
  if (!isOpfsAvailable()) return [];

  let jobsDirectory: any;
  try {
    const root: any = await navigator.storage.getDirectory();
    const pixelpress = await root.getDirectoryHandle('pixelpress');
    jobsDirectory = await pixelpress.getDirectoryHandle('jobs');
  } catch {
    return [];
  }

  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const restored: Job[] = [];
  const expired: string[] = [];

  try {
    for await (const [jobId, handle] of jobsDirectory.entries()) {
      if (handle.kind !== 'directory') continue;

      let metadata: StoredMetadata | null = null;
      let hasOutput = false;
      let newestFile = 0;
      try {
        for await (const [fileName, fileHandle] of handle.entries()) {
          if (fileHandle.kind !== 'file') continue;
          const file: File = await fileHandle.getFile();
          newestFile = Math.max(newestFile, file.lastModified || 0);
          if (fileName.startsWith('output.')) hasOutput = true;
          if (fileName === 'metadata.json') {
            try {
              metadata = JSON.parse(await file.text()) as StoredMetadata;
            } catch {
              metadata = null;
            }
          }
        }
      } catch {
        continue;
      }

      const completedAt = metadata?.completedAt || newestFile;
      if (completedAt && completedAt < cutoff) {
        expired.push(jobId);
        continue;
      }
      if (!metadata || !metadata.opfsPath) continue;
      if (!hasOutput) {
        expired.push(jobId);
        continue;
      }

      try {
        await handle.removeEntry('input.pdf');
      } catch {
        /* stale input is fine to leave */
      }

      restored.push({
        id: jobId,
        name: metadata.originalName || metadata.outputName || jobId,
        originalSize: metadata.originalSize || 0,
        outputSize: metadata.size != null ? metadata.size : null,
        settings: { ...DEFAULT_SETTINGS, ...(metadata.settings ?? {}) },
        status: 'done',
        progress: 100,
        completedAt,
        message: formatTextSummary(metadata.textSummary, 0, metadata.usedOriginal),
        textSummary: metadata.textSummary ?? null,
        outputName: metadata.outputName || 'document-pixelpress.pdf',
        opfsPath: metadata.opfsPath,
        downloadUrl: null,
        usedOriginal: metadata.usedOriginal,
      });
    }
  } catch {
    return sortNewestFirst(restored);
  }

  for (const jobId of expired) {
    try {
      await jobsDirectory.removeEntry(jobId, { recursive: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return sortNewestFirst(restored);
}

function sortNewestFirst(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}
