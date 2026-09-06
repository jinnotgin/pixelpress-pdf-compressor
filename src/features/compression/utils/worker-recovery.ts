import { type WorkerFallback } from '../types';

export type FatalRiskPhase = 'ocr-render' | 'image-optimization' | null;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function isRuntimeBoundsTrap(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('index out of bounds') ||
    message.includes('out of bounds memory access') ||
    message.includes('memory access out of bounds')
  );
}

export function recoveryForFatalError(
  error: unknown,
  phase: FatalRiskPhase,
  applied: readonly WorkerFallback[],
): WorkerFallback | undefined {
  if (!isRuntimeBoundsTrap(error)) return undefined;
  const fallback =
    phase === 'ocr-render'
      ? 'skip-ocr'
      : phase === 'image-optimization'
        ? 'skip-image-optimization'
        : undefined;
  return fallback && !applied.includes(fallback) ? fallback : undefined;
}
