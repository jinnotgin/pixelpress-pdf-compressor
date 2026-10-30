import { describe, expect, it } from 'vitest';

import { compareSizes, intakeFiles, savingsPercent } from './jobs';
import { DEFAULT_SETTINGS } from './settings';

// `new File()` in the test env doesn't preserve an arbitrary `size`, so use a
// minimal structural stand-in for the few fields `intakeFiles` reads.
function file(name: string, size: number, type = 'application/pdf'): File {
  return { name, size, type } as unknown as File;
}

describe('savingsPercent', () => {
  it('returns null before there is a result', () => {
    expect(savingsPercent({ originalSize: 1000, outputSize: null })).toBeNull();
    expect(savingsPercent({ originalSize: 1000, outputSize: undefined })).toBeNull();
  });

  it('computes percentage saved and allows negatives', () => {
    expect(savingsPercent({ originalSize: 1000, outputSize: 400 })).toBe(60);
    expect(savingsPercent({ originalSize: 1000, outputSize: 1200 })).toBe(-20);
  });
});

describe('compareSizes', () => {
  it('distinguishes smaller, unchanged, and larger results', () => {
    expect(compareSizes({ originalSize: 1000, outputSize: 900 })).toBe('smaller');
    expect(compareSizes({ originalSize: 1000, outputSize: 1000 })).toBe('same');
    expect(compareSizes({ originalSize: 1000, outputSize: 1100 })).toBe('larger');
  });

  it('returns null before there is a result', () => {
    expect(compareSizes({ originalSize: 1000, outputSize: null })).toBeNull();
    expect(compareSizes({ originalSize: 1000, outputSize: undefined })).toBeNull();
  });
});

describe('intakeFiles', () => {
  it('rejects non-pdf and oversized files with a reason', () => {
    const result = intakeFiles(
      [file('a.pdf', 10), file('b.txt', 10, 'text/plain'), file('c.pdf', 300 * 1024 * 1024)],
      DEFAULT_SETTINGS,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].name).toBe('a.pdf');
    expect(result.rejected).toEqual(['b.txt is not a PDF', 'c.pdf is larger than 250 MB']);
  });

  it('accepts by .pdf extension even without a mime type', () => {
    const result = intakeFiles([file('scan.PDF', 5, '')], DEFAULT_SETTINGS);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].status).toBe('pending');
  });
});
