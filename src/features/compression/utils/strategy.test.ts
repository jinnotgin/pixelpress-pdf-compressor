import { describe, expect, it } from 'vitest';

import { type PageAnalysis } from '../types';
import { choosePageStrategy, explainPageStrategy } from './strategy';

const DOCUMENT_PAGE: PageAnalysis = {
  usable: true,
  characters: 2_400,
  words: 420,
  hidden: false,
  imageCoverage: 0,
  contentBytes: 42_000,
  protected: false,
};

describe('choosePageStrategy', () => {
  it('preserves ordinary document pages in auto mode', () => {
    expect(choosePageStrategy('auto', DOCUMENT_PAGE)).toBe('optimize');
    expect(explainPageStrategy('auto', DOCUMENT_PAGE)).toMatchObject({
      strategy: 'optimize',
      reason: 'Preserved because content streams are below 220 KB.',
      checks: {
        imageCoverageBelow55Percent: true,
        contentAtLeast220KB: false,
        fewerThan120Words: false,
        contentAtLeast700KB: false,
      },
    });
  });

  it('flattens pages with a large non-image content stream', () => {
    const page = { ...DOCUMENT_PAGE, words: 80, contentBytes: 500_000 };
    expect(choosePageStrategy('auto', page)).toBe('flatten');
    expect(explainPageStrategy('auto', page).reason).toContain('exceeded 220 KB');
  });

  it('never auto-flattens protected PDF content', () => {
    expect(
      choosePageStrategy('auto', {
        ...DOCUMENT_PAGE,
        protected: true,
        contentBytes: 900_000,
      }),
    ).toBe('optimize');
  });

  it('honours an explicit custom strategy', () => {
    expect(choosePageStrategy('flatten', DOCUMENT_PAGE)).toBe('flatten');
    expect(choosePageStrategy('optimize', { ...DOCUMENT_PAGE, contentBytes: 900_000 })).toBe(
      'optimize',
    );
  });
});
