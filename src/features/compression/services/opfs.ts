/**
 * Main-thread helpers for reading results back out of the Origin Private File
 * System. Writes happen inside the worker (see `workers/pixelpress.worker.ts`).
 */

/* The sync-access / iterator parts of the OPFS API are still ahead of the DOM
   lib types in places, so the handles are treated loosely here. */
type AnyDirectoryHandle = {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<AnyDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{ getFile(): Promise<File> }>;
};

export function isOpfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

export async function readOpfsFile(path: string): Promise<File> {
  const parts = path.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error('Invalid OPFS path.');

  let directory = (await navigator.storage.getDirectory()) as unknown as AnyDirectoryHandle;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part);
  }
  const handle = await directory.getFileHandle(filename);
  return handle.getFile();
}
