import { describe, expect, it } from 'vitest';

import { isRuntimeBoundsTrap, recoveryForFatalError } from './worker-recovery';

describe('PDF worker fatal-error recovery', () => {
  it('recognises the WebAssembly bounds trap reported by Pyodide', () => {
    expect(isRuntimeBoundsTrap(new Error('index out of bounds'))).toBe(true);
    expect(isRuntimeBoundsTrap('RuntimeError: out of bounds memory access')).toBe(true);
    expect(isRuntimeBoundsTrap(new Error('Bad PatternType'))).toBe(false);
  });

  it('falls back from a fatal OCR render once', () => {
    const error = new Error('index out of bounds');
    expect(recoveryForFatalError(error, 'ocr-render', [])).toBe('skip-ocr');
    expect(recoveryForFatalError(error, 'ocr-render', ['skip-ocr'])).toBeUndefined();
  });

  it('falls back from fatal embedded-image optimization once', () => {
    const error = new Error('index out of bounds');
    expect(recoveryForFatalError(error, 'image-optimization', [])).toBe('skip-image-optimization');
    expect(
      recoveryForFatalError(error, 'image-optimization', ['skip-image-optimization']),
    ).toBeUndefined();
  });

  it('does not retry unrelated failures or failures outside a risky phase', () => {
    expect(
      recoveryForFatalError(new Error('cannot open document'), 'ocr-render', []),
    ).toBeUndefined();
    expect(recoveryForFatalError(new Error('index out of bounds'), null, [])).toBeUndefined();
  });
});
