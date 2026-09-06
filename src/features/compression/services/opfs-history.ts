import { HISTORY_MAX_AGE_MS, ORIGINAL_KEPT_WARNING } from '../config';
import { type Job } from '../types';
import { DEFAULT_SETTINGS } from '../utils/settings';
import { formatTextSummary } from '../utils/text-summary';

import { scanJobFolders } from './job-folders';

/**
 * Reads back finished jobs written to OPFS by earlier sessions and deletes
 * anything past the retention window. Recent folders without metadata belong to
 * a run that is still in flight (or was interrupted), so they are left alone
 * rather than pulled out from under another tab — see `job-folders.ts` for the
 * rule the storage readout shares.
 */
export async function restoreOpfsHistory(): Promise<Job[]> {
  const scan = await scanJobFolders(Date.now() - HISTORY_MAX_AGE_MS);
  if (!scan) return [];

  const restored: Job[] = [];
  const expired: string[] = [];

  for (const folder of scan.folders) {
    if (folder.kind === 'expired') {
      expired.push(folder.id);
      continue;
    }
    if (folder.kind === 'orphan') continue;

    const { metadata, completedAt } = folder;
    try {
      await folder.handle.removeEntry('input.pdf');
    } catch {
      /* stale input is fine to leave */
    }

    restored.push({
      id: folder.id,
      name: metadata.originalName || metadata.outputName || folder.id,
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
      warning: metadata.warning ?? (metadata.usedOriginal ? ORIGINAL_KEPT_WARNING : undefined),
    });
  }

  for (const jobId of expired) {
    try {
      await scan.jobs.removeEntry(jobId, { recursive: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return [...restored].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}
