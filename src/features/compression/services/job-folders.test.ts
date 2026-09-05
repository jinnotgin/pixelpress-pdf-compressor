import { describe, expect, it } from 'vitest';

import { classifyJobFolder, type AnyFileSystemHandle } from './job-folders';

const NOW = 1_700_000_000_000;
const CUTOFF = NOW - 30 * 24 * 60 * 60 * 1000;

interface FakeFile {
  name: string;
  size: number;
  lastModified?: number;
  text?: string;
}

/** Minimal stand-in for an OPFS directory handle holding a flat list of files. */
function folder(files: FakeFile[], options?: { unreadable?: boolean }): AnyFileSystemHandle {
  return {
    kind: 'directory',
    async *entries() {
      if (options?.unreadable) throw new Error('handle is held open elsewhere');
      for (const file of files) {
        yield [
          file.name,
          {
            kind: 'file',
            getFile: async () => ({
              size: file.size,
              lastModified: file.lastModified ?? NOW,
              text: async () => file.text ?? '',
            }),
          },
        ];
      }
    },
  } as unknown as AnyFileSystemHandle;
}

function metadataFile(overrides: Record<string, unknown> = {}, size = 200): FakeFile {
  return {
    name: 'metadata.json',
    size,
    text: JSON.stringify({
      opfsPath: 'pixelpress/jobs/job-1/output.pdf',
      outputName: 'document-pixelpress.pdf',
      completedAt: NOW - 1000,
      size: 4_000,
      ...overrides,
    }),
  };
}

describe('job folder classification', () => {
  it('calls a folder with metadata and an output a result', async () => {
    const result = await classifyJobFolder(
      'job-1',
      folder([metadataFile(), { name: 'output.pdf', size: 4_000 }]),
      CUTOFF,
    );

    expect(result.kind).toBe('result');
    expect(result.bytes).toBe(4_200);
    if (result.kind !== 'result') return;
    expect(result.completedAt).toBe(NOW - 1000);
    expect(result.metadata.opfsPath).toBe('pixelpress/jobs/job-1/output.pdf');
  });

  it('counts a staged input with no result as working files, not as a processed PDF', async () => {
    // The bug this classifier exists for: an interrupted run leaves the whole
    // original on disk, and the storage dialog used to bill it as a result.
    const result = await classifyJobFolder(
      'job-2',
      folder([{ name: 'input.pdf', size: 180_000_000 }]),
      CUTOFF,
    );

    expect(result.kind).toBe('orphan');
    expect(result.bytes).toBe(180_000_000);
  });

  it('treats an output whose metadata never landed as still in flight', async () => {
    const result = await classifyJobFolder(
      'job-3',
      folder([{ name: 'output.pdf', size: 4_000 }]),
      CUTOFF,
    );

    expect(result.kind).toBe('orphan');
  });

  it('treats unparseable metadata as no metadata at all', async () => {
    const result = await classifyJobFolder(
      'job-4',
      folder([{ name: 'metadata.json', size: 20, text: '{ truncated' }]),
      CUTOFF,
    );

    expect(result.kind).toBe('orphan');
  });

  it('expires metadata pointing at an output that is gone', async () => {
    const result = await classifyJobFolder('job-5', folder([metadataFile()]), CUTOFF);

    expect(result.kind).toBe('expired');
  });

  it('expires anything past the retention window, with or without metadata', async () => {
    const stale = NOW - 40 * 24 * 60 * 60 * 1000;

    await expect(
      classifyJobFolder(
        'job-6',
        folder([
          metadataFile({ completedAt: stale }),
          { name: 'output.pdf', size: 4_000, lastModified: stale },
        ]),
        CUTOFF,
      ),
    ).resolves.toMatchObject({ kind: 'expired' });

    await expect(
      classifyJobFolder(
        'job-7',
        folder([{ name: 'input.pdf', size: 900, lastModified: stale }]),
        CUTOFF,
      ),
    ).resolves.toMatchObject({ kind: 'expired' });
  });

  it('expires an empty folder, which no timestamp could ever retire', async () => {
    const result = await classifyJobFolder('job-8', folder([]), CUTOFF);

    expect(result.kind).toBe('expired');
    expect(result.bytes).toBe(0);
  });

  it('never deletes a folder it could not read', async () => {
    const result = await classifyJobFolder('job-9', folder([], { unreadable: true }), CUTOFF);

    expect(result.kind).toBe('orphan');
  });
});
