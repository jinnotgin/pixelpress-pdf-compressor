/**
 * A stand-in for progress the worker genuinely cannot measure.
 *
 * PyMuPDF's own image pass and `save()` are single blocking calls, and Pyodide
 * runs on the worker thread — so a timer inside the worker would be frozen for
 * exactly as long as the call it is meant to cover. The ramp therefore runs on
 * the UI thread, driven by a duration the worker estimates before it blocks.
 *
 * It approaches the end of its band asymptotically and never arrives, so an
 * estimate that turns out too short shows up as the bar slowing to a crawl just
 * short of the next phase rather than overshooting into it.
 */

/** How much of the band is covered by the time the estimated duration elapses. */
const SPENT_AT_ETA = 0.8;

/** Roughly ten updates a second: smooth enough for a bar, cheap enough to render. */
const TICK_MS = 100;

/**
 * How far short of the band the ramp is held. The curve only approaches its
 * ceiling in theory; past roughly forty times the estimate `exp()` underflows
 * to zero and the arithmetic lands exactly on it, which would let an estimate
 * that ran long spill into the phase that follows.
 */
const CEILING_GAP = 0.1;

export interface ProgressRampOptions {
  from: number;
  to: number;
  etaMs: number;
  onProgress: (progress: number) => void;
  /** Injectable for tests; defaults to the real timer and clock. */
  now?: () => number;
  setTimer?: (tick: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface ProgressRamp {
  stop: () => void;
}

/** Where an asymptotic ramp sits after `elapsed`. Never reaches `to`. */
export function estimatedProgress(
  from: number,
  to: number,
  etaMs: number,
  elapsed: number,
): number {
  if (to <= from) return from;
  if (!(etaMs > 0) || elapsed <= 0) return from;
  // Position is derived from elapsed wall clock rather than accumulated, so a
  // backgrounded tab that stops ticking resumes at the right place instead of
  // lagging by however long it was hidden.
  const tau = etaMs / -Math.log(1 - SPENT_AT_ETA);
  const reached = from + (to - from) * (1 - Math.exp(-elapsed / tau));
  return Math.max(from, Math.min(reached, to - CEILING_GAP));
}

export function startProgressRamp({
  from,
  to,
  etaMs,
  onProgress,
  now = () => Date.now(),
  setTimer = (tick, ms) => self.setInterval(tick, ms),
  clearTimer = (handle) => self.clearInterval(handle),
}: ProgressRampOptions): ProgressRamp {
  const startedAt = now();
  let last = from;
  onProgress(from);
  const handle = setTimer(() => {
    const next = Math.round(estimatedProgress(from, to, etaMs, now() - startedAt) * 10) / 10;
    // The tail of the curve moves in fractions of a percent; skipping repeats
    // keeps a long stall from re-rendering the queue ten times a second.
    if (next > last) {
      last = next;
      onProgress(next);
    }
  }, TICK_MS);
  return {
    stop: () => clearTimer(handle),
  };
}

/**
 * Divide `[from, to]` between stages in proportion to how long each is expected
 * to take, returning the boundary after each one. A stage with no work gets no
 * width, so the bar never sits in a stretch where nothing is happening — which
 * is the difference between strategies here. Flattening does everything in the
 * per-page pass and reaches no image pass at all; preserving is the reverse.
 */
export function splitBand(from: number, to: number, etas: readonly number[]): number[] {
  const total = etas.reduce((sum, eta) => sum + eta, 0);
  let boundary = from;
  return etas.map((eta) => {
    boundary += total > 0 ? ((to - from) * eta) / total : (to - from) / etas.length;
    return Math.round(boundary * 10) / 10;
  });
}
