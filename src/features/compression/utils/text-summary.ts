import { type TextSummary } from '../types';

/**
 * Turns the per-page text accounting from the worker into a one-line status
 * such as `"Ready: 3 native text preserved · 2 pages text recognised"`.
 */
export function formatTextSummary(
  summary: TextSummary | null | undefined,
  pages: number,
  usedOriginal = false,
): string {
  if (usedOriginal) return 'Ready: source was already compact, so the original was kept';
  const fallback = `Ready, ${pages} page${pages === 1 ? '' : 's'} processed locally`;
  if (!summary) return fallback;

  const parts: string[] = [];
  if (summary.nativePages) parts.push(`${summary.nativePages} native text preserved`);
  if (summary.rebuiltPages) parts.push(`${summary.rebuiltPages} text layer rebuilt`);
  if (summary.ocrPages) {
    parts.push(`${summary.ocrPages} page${summary.ocrPages === 1 ? '' : 's'} text recognised`);
  }
  if (summary.imageOnlyPages) parts.push(`${summary.imageOnlyPages} image-only`);

  return parts.length ? `Ready: ${parts.join(' · ')}` : fallback;
}
