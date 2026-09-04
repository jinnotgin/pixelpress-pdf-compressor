import { type PageAnalysis, type Strategy } from '../types';

export type PageStrategy = Exclude<Strategy, 'auto'>;

export const AUTO_STRATEGY_THRESHOLDS = {
  maximumImageCoverage: 0.55,
  likelyVectorContentBytes: 220_000,
  likelyVectorMaximumWords: 120,
  definiteVectorContentBytes: 700_000,
} as const;

export interface PageStrategyDecision {
  strategy: PageStrategy;
  reason: string;
  checks: {
    imageCoverageBelow55Percent: boolean;
    contentAtLeast220KB: boolean;
    fewerThan120Words: boolean;
    contentAtLeast700KB: boolean;
  };
}

/**
 * Auto is deliberately conservative. A wrong preserve decision only misses a
 * possible saving; a wrong flatten decision discards native PDF structure.
 */
export function explainPageStrategy(strategy: Strategy, page: PageAnalysis): PageStrategyDecision {
  const checks = {
    imageCoverageBelow55Percent:
      page.imageCoverage < AUTO_STRATEGY_THRESHOLDS.maximumImageCoverage,
    contentAtLeast220KB:
      page.contentBytes >= AUTO_STRATEGY_THRESHOLDS.likelyVectorContentBytes,
    fewerThan120Words: page.words < AUTO_STRATEGY_THRESHOLDS.likelyVectorMaximumWords,
    contentAtLeast700KB:
      page.contentBytes >= AUTO_STRATEGY_THRESHOLDS.definiteVectorContentBytes,
  };

  if (strategy === 'flatten') {
    return { strategy, reason: 'Flatten was explicitly selected.', checks };
  }
  if (strategy === 'optimize') {
    return { strategy, reason: 'Preserve was explicitly selected.', checks };
  }
  if (page.protected) {
    return {
      strategy: 'optimize',
      reason: 'Preserved because the document contains protected or interactive structure.',
      checks,
    };
  }

  // Content-stream size is a cheap, bounded proxy for vector complexity. It is
  // intentionally preferable to materialising every drawing path in WASM,
  // which can exhaust or destabilise the runtime on the Figma exports this
  // branch is specifically meant to identify.
  const vectorHeavyPage =
    checks.imageCoverageBelow55Percent &&
    ((checks.contentAtLeast220KB && checks.fewerThan120Words) || checks.contentAtLeast700KB);

  if (vectorHeavyPage) {
    return {
      strategy: 'flatten',
      reason: checks.contentAtLeast700KB
        ? 'Flattened because non-image content streams exceeded 700 KB.'
        : 'Flattened because non-image content streams exceeded 220 KB on a page with fewer than 120 words.',
      checks,
    };
  }

  const failedChecks = [
    !checks.imageCoverageBelow55Percent && 'a detected image covers at least 55% of the page',
    !checks.contentAtLeast220KB && 'content streams are below 220 KB',
    checks.contentAtLeast220KB &&
      !checks.fewerThan120Words &&
      !checks.contentAtLeast700KB &&
      'the page has at least 120 words and content streams are below 700 KB',
  ].filter((reason): reason is string => Boolean(reason));

  return {
    strategy: 'optimize',
    reason: `Preserved because ${failedChecks.join(' and ')}.`,
    checks,
  };
}

export function choosePageStrategy(strategy: Strategy, page: PageAnalysis): PageStrategy {
  return explainPageStrategy(strategy, page).strategy;
}
