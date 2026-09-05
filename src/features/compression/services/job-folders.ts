/**
 * One rule for what a folder under `pixelpress/jobs` actually is.
 *
 * History restore and storage accounting both walk these folders, and they used
 * to disagree: restore required metadata plus an output file before it would
 * call something a result, while the storage readout counted every directory as
 * one. A folder holding only the staged `input.pdf` of an interrupted run — the
 * largest single file this app ever writes — was reported to the user as a
 * processed PDF. Classifying in one place keeps the two views of the disk in
 * step.
 */

import { type Job } from '../types';

import { isOpfsAvailable } from './opfs';

/* The sync-access and iterator halves of the OPFS API are still ahead of the
   DOM lib types, so handles are treated loosely here. */
export type AnyDirectoryHandle = {
  entries(): AsyncIterableIterator<[string, AnyFileSystemHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<AnyDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};
export type AnyFileSystemHandle = AnyDirectoryHandle & {
  kind: 'file' | 'directory';
  getFile(): Promise<File>;
};

/** What the worker writes beside a finished result. */
export interface StoredMetadata {
  originalName?: string;
  outputName?: string;
  originalSize?: number;
  size?: number;
  opfsPath?: string;
  completedAt?: number;
  settings?: Partial<Job['settings']>;
  textSummary?: Job['textSummary'];
  usedOriginal?: boolean;
  warning?: string;
}

interface FolderBase {
  id: string;
  handle: AnyFileSystemHandle;
  /** Everything the folder holds right now, result or not. */
  bytes: number;
}

export type JobFolder =
  /** A finished run: metadata, an output file, and a download the user can still take. */
  | (FolderBase & {
      kind: 'result';
      metadata: StoredMetadata & { opfsPath: string };
      completedAt: number;
    })
  /** Working files with no retrievable result — a run that died, or one still going. */
  | (FolderBase & { kind: 'orphan' })
  /** Past the retention window, or a shell with nothing in it. Safe to remove. */
  | (FolderBase & { kind: 'expired' });

const ROOT_DIRECTORY = 'pixelpress';

export async function openOpfsRoot(): Promise<AnyDirectoryHandle | null> {
  if (!isOpfsAvailable()) return null;
  try {
    return (await navigator.storage.getDirectory()) as unknown as AnyDirectoryHandle;
  } catch {
    return null;
  }
}

export async function openJobsDirectory(options?: {
  create?: boolean;
}): Promise<AnyDirectoryHandle | null> {
  const root = await openOpfsRoot();
  if (!root) return null;
  try {
    const pixelpress = await root.getDirectoryHandle(ROOT_DIRECTORY, options);
    return await pixelpress.getDirectoryHandle('jobs', options);
  } catch {
    return null;
  }
}

/** Recursive byte total, skipping anything the worker holds open right now. */
export async function directoryBytes(directory: AnyDirectoryHandle): Promise<number> {
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

/**
 * Reads one job folder in a single pass. Sizes, timestamps and metadata all
 * come from the same `getFile()` calls, so callers that only want bytes pay
 * nothing extra for the classification.
 */
export async function classifyJobFolder(
  id: string,
  handle: AnyFileSystemHandle,
  cutoff: number,
): Promise<JobFolder> {
  let metadata: StoredMetadata | null = null;
  let hasOutput = false;
  let newestFile = 0;
  let bytes = 0;
  let files = 0;

  try {
    for await (const [fileName, fileHandle] of handle.entries()) {
      if (fileHandle.kind !== 'file') {
        bytes += await directoryBytes(fileHandle);
        continue;
      }
      const file = await fileHandle.getFile();
      files += 1;
      bytes += file.size;
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
    // An unreadable folder is never deleted: it may be one another tab is
    // writing into, and losing a result costs more than keeping a few bytes.
    return { kind: 'orphan', id, handle, bytes };
  }

  // A folder with no files has no timestamp either, so age can never retire it.
  // Left alone it would sit in the count forever at zero bytes. The worker
  // recreates the folder on its next write, so removing an empty one is safe.
  if (files === 0) return { kind: 'expired', id, handle, bytes };

  const completedAt = metadata?.completedAt || newestFile;
  if (completedAt && completedAt < cutoff) return { kind: 'expired', id, handle, bytes };

  // No metadata means the run never reached the end. It may still be in flight
  // in another tab, so it is reported but not reaped.
  if (!metadata || !metadata.opfsPath) return { kind: 'orphan', id, handle, bytes };

  // Metadata without the file it points at is a dead end nothing can restore.
  if (!hasOutput) return { kind: 'expired', id, handle, bytes };

  return {
    kind: 'result',
    id,
    handle,
    bytes,
    metadata: metadata as StoredMetadata & { opfsPath: string },
    completedAt,
  };
}

/** Classifies every job folder. Null when OPFS holds nothing for this app yet. */
export async function scanJobFolders(
  cutoff: number,
): Promise<{ jobs: AnyDirectoryHandle; folders: JobFolder[] } | null> {
  const jobs = await openJobsDirectory();
  if (!jobs) return null;

  const folders: JobFolder[] = [];
  try {
    for await (const [id, handle] of jobs.entries()) {
      if (handle.kind !== 'directory') continue;
      folders.push(await classifyJobFolder(id, handle, cutoff));
    }
  } catch {
    /* report what was classified before the walk failed */
  }
  return { jobs, folders };
}
