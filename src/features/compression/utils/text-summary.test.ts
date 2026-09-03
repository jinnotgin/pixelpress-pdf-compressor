import { describe, expect, it } from 'vitest';

import { formatTextSummary } from './text-summary';

describe('formatTextSummary', () => {
  it('falls back to a page count when there is no summary', () => {
    expect(formatTextSummary(null, 1)).toBe('Ready, 1 page processed locally');
    expect(formatTextSummary(undefined, 4)).toBe('Ready, 4 pages processed locally');
  });

  it('joins the non-zero buckets', () => {
    expect(
      formatTextSummary({ nativePages: 3, rebuiltPages: 0, ocrPages: 2, imageOnlyPages: 1 }, 6),
    ).toBe('Ready: 3 native text preserved · 2 pages text recognised · 1 image-only');
  });

  it('singularises the OCR bucket', () => {
    expect(
      formatTextSummary({ nativePages: 0, rebuiltPages: 0, ocrPages: 1, imageOnlyPages: 0 }, 1),
    ).toBe('Ready: 1 page text recognised');
  });

  it('falls back when every bucket is zero', () => {
    expect(
      formatTextSummary({ nativePages: 0, rebuiltPages: 0, ocrPages: 0, imageOnlyPages: 0 }, 2),
    ).toBe('Ready, 2 pages processed locally');
  });
});
