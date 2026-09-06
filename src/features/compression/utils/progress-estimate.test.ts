import { describe, expect, it } from 'vitest';

import { estimatedProgress, splitBand, startProgressRamp } from './progress-estimate';

describe('estimated progress for stages that cannot report their own', () => {
  it('covers most of the band by the estimated time and never leaves it', () => {
    expect(estimatedProgress(92, 96, 1000, 0)).toBe(92);
    expect(estimatedProgress(92, 96, 1000, 1000)).toBeCloseTo(95.2, 5);
    // Long past the estimate the curve is held a step short of the ceiling, so
    // an overrun stalls the bar instead of spilling into the next phase.
    expect(estimatedProgress(92, 96, 1000, 60_000)).toBe(95.9);
    expect(estimatedProgress(92, 96, 1000, Number.MAX_SAFE_INTEGER)).toBe(95.9);
  });

  it('rises without ever going backwards', () => {
    const samples = [0, 100, 500, 2000, 8000].map((elapsed) =>
      estimatedProgress(60, 66, 1500, elapsed),
    );
    expect(samples).toStrictEqual([...samples].sort((a, b) => a - b));
  });

  it('holds still when the band is empty or the estimate is missing', () => {
    expect(estimatedProgress(96, 96, 1000, 5000)).toBe(96);
    expect(estimatedProgress(96, 92, 1000, 5000)).toBe(96);
    expect(estimatedProgress(60, 66, 0, 5000)).toBe(60);
  });
});

describe('the ramp driving those stages', () => {
  function harness() {
    const reported: number[] = [];
    let elapsed = 0;
    let tick = (): void => {};
    let cleared = 0;
    const ramp = startProgressRamp({
      from: 86,
      to: 92,
      etaMs: 1000,
      onProgress: (progress) => reported.push(progress),
      now: () => elapsed,
      setTimer: (scheduled) => {
        tick = scheduled;
        return 7;
      },
      clearTimer: (handle) => {
        cleared = handle;
      },
    });
    return {
      reported,
      ramp,
      advance: (ms: number) => {
        elapsed += ms;
        tick();
      },
      clearedHandle: () => cleared,
    };
  }

  it('reports the start of the band immediately', () => {
    expect(harness().reported).toStrictEqual([86]);
  });

  it('advances monotonically and stays inside the band', () => {
    const { reported, advance } = harness();
    for (let step = 0; step < 40; step += 1) advance(100);
    expect(reported.length).toBeGreaterThan(1);
    expect(reported).toStrictEqual([...reported].sort((a, b) => a - b));
    expect(Math.max(...reported)).toBeLessThan(92);
  });

  it('skips ticks that would repeat the last reported value', () => {
    const { reported, advance } = harness();
    // Far out on the tail the curve moves by less than the rounding step.
    for (let step = 0; step < 30; step += 1) advance(1000);
    const settled = reported.length;
    for (let step = 0; step < 30; step += 1) advance(1000);
    expect(reported.length).toBe(settled);
  });

  it('releases its timer when stopped', () => {
    const { ramp, clearedHandle } = harness();
    ramp.stop();
    expect(clearedHandle()).toBe(7);
  });
});

describe('sizing each stage against the work it actually has', () => {
  it('divides the band in proportion to the estimates', () => {
    expect(splitBand(0, 100, [1, 1])).toStrictEqual([50, 100]);
    expect(splitBand(60, 96, [3, 1])).toStrictEqual([87, 96]);
  });

  it('gives a stage with no work no width at all', () => {
    // An all-flatten job reaches neither image pass, so both collapse onto the
    // start of the band and saving the file owns the whole stretch.
    expect(splitBand(66, 96, [0, 0, 25])).toStrictEqual([66, 66, 96]);
    // A preserved document whose rasters are all lossy skips only the first.
    const [images, native] = splitBand(66, 96, [0, 440, 25]);
    expect(images).toBe(66);
    expect(native).toBeGreaterThan(66);
    expect(native).toBeLessThan(96);
  });

  it('always ends exactly on the end of the band', () => {
    for (const etas of [[1, 2, 3], [0, 0, 1], [7, 0, 0], [5]]) {
      expect(splitBand(8, 96, etas).at(-1)).toBe(96);
    }
  });

  it('falls back to equal slices when nothing has an estimate', () => {
    expect(splitBand(0, 90, [0, 0, 0])).toStrictEqual([30, 60, 90]);
  });
});
