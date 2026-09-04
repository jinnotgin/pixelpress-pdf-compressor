import { IMAGE_DETAIL_OPTIONS, OCR_LANGUAGE_OPTIONS } from '../config';
import {
  type ImageDetail,
  type OcrLanguage,
  type Preset,
  type ResolvedSettings,
  type Settings,
  type Strategy,
} from '../types';

export const PRESET_VALUES = ['auto', 'figma', 'custom'] as const satisfies readonly Preset[];
export const STRATEGY_VALUES = ['auto', 'flatten', 'optimize'] as const satisfies readonly Strategy[];
export const OCR_LANGUAGE_VALUES = OCR_LANGUAGE_OPTIONS.map(({ value }) => value);
export const IMAGE_DETAIL_VALUES = IMAGE_DETAIL_OPTIONS.map(({ value }) => value);

export const DEFAULT_SETTINGS: Settings = {
  preset: 'auto',
  strategy: 'auto',
  flattenDpi: 96,
  imageDetail: 'screen',
  jpegQuality: 78,
  recognizeText: true,
  ocrLanguage: 'eng',
};

export const PRESET_COPY: Record<Preset, string> = {
  auto: 'Chooses the best approach page by page, and keeps the original if it is smaller.',
  figma: 'Flattens every page for compact Figma screens, diagrams, and vector-heavy exports.',
  custom: 'Pick the strategy, resolution, and JPEG quality limits yourself.',
};

export const IMAGE_DETAIL_COPY: Record<ImageDetail, string> = {
  compact: 'Smallest. Drops photos to around 75 DPI, which is soft when zoomed or printed.',
  screen: 'Drops photos to around 150 DPI. Sharp on screen and usable in print.',
  print: 'Recompresses photos without giving up resolution. Largest, and safe to print.',
};

export const STRATEGY_COPY: Record<Strategy, string> = {
  auto: 'Preserves documents and flattens only clearly vector-heavy pages. Keeps the original if compression does not help.',
  flatten:
    'Turns each page into a single image, then rebuilds a searchable text layer on top. Good for visually dense PDFs, but vectors and fonts are not kept.',
  optimize:
    'Keeps the original text and vector artwork, recompressing only the images embedded in the page.',
};

export function isPreset(value: unknown): value is Preset {
  return typeof value === 'string' && (PRESET_VALUES as readonly string[]).includes(value);
}

export function isStrategy(value: unknown): value is Strategy {
  return typeof value === 'string' && (STRATEGY_VALUES as readonly string[]).includes(value);
}

export function isImageDetail(value: unknown): value is ImageDetail {
  return typeof value === 'string' && (IMAGE_DETAIL_VALUES as readonly string[]).includes(value);
}

export function isOcrLanguage(value: unknown): value is OcrLanguage {
  return typeof value === 'string' && (OCR_LANGUAGE_VALUES as readonly string[]).includes(value);
}

/**
 * Expands a preset into the concrete values a job runs with. `auto` and
 * `figma` are fixed recipes; `custom` uses whatever the user configured.
 * OCR preferences are always taken from the live settings.
 */
export function resolveSettings(settings: Settings): ResolvedSettings {
  if (settings.preset === 'auto') {
    return {
      preset: 'auto',
      strategy: 'auto',
      // Auto runs both branches within one document, so it carries both
      // settings. Flattening rasterises text and vectors and has to stay
      // conservative; preserving only bounds embedded photographs, which costs
      // far less, so it can afford to keep more detail.
      flattenDpi: 96,
      imageDetail: 'screen',
      jpegQuality: 78,
      recognizeText: settings.recognizeText,
      ocrLanguage: settings.ocrLanguage,
    };
  }
  if (settings.preset === 'custom') {
    return {
      preset: 'custom',
      strategy: settings.strategy,
      flattenDpi: settings.flattenDpi,
      imageDetail: settings.imageDetail,
      jpegQuality: settings.jpegQuality,
      recognizeText: settings.recognizeText,
      ocrLanguage: settings.ocrLanguage,
    };
  }
  // Figma flattens every page, so it never reaches the embedded-image pass.
  return {
    preset: 'figma',
    strategy: 'flatten',
    flattenDpi: 96,
    imageDetail: 'screen',
    jpegQuality: 78,
    recognizeText: settings.recognizeText,
    ocrLanguage: settings.ocrLanguage,
  };
}

/** Merge unknown persisted data onto the defaults, dropping invalid enum values. */
export function normalizeStoredSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
  const stored = raw as Partial<Settings>;
  const legacyPreset =
    stored.preset === ('high' as Preset)
      ? 'figma'
      : stored.preset === ('balanced' as Preset)
        ? 'auto'
        : stored.preset;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    preset: isPreset(legacyPreset) ? legacyPreset : DEFAULT_SETTINGS.preset,
    strategy: isStrategy(stored.strategy) ? stored.strategy : DEFAULT_SETTINGS.strategy,
    imageDetail: isImageDetail(stored.imageDetail)
      ? stored.imageDetail
      : DEFAULT_SETTINGS.imageDetail,
    ocrLanguage: isOcrLanguage(stored.ocrLanguage)
      ? stored.ocrLanguage
      : DEFAULT_SETTINGS.ocrLanguage,
  };
}
