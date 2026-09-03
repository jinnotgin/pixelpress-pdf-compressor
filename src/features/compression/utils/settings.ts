import { type Preset, type ResolvedSettings, type Settings, type Strategy } from '../types';

export const PRESET_VALUES = ['high', 'balanced', 'custom'] as const satisfies readonly Preset[];
export const STRATEGY_VALUES = ['flatten', 'optimize'] as const satisfies readonly Strategy[];

export const DEFAULT_SETTINGS: Settings = {
  preset: 'high',
  strategy: 'flatten',
  dpi: 96,
  jpegQuality: 78,
  recognizeText: true,
};

export const PRESET_COPY: Record<Preset, string> = {
  high: 'Flattens page visuals for the lightest file, then rebuilds existing searchable text.',
  balanced: 'Preserves original text and vectors while recompressing embedded images.',
  custom: 'Pick the strategy, resolution, and JPEG quality limits yourself.',
};

export const STRATEGY_COPY: Record<Strategy, string> = {
  flatten:
    'Turns each page into a single image, then rebuilds a searchable text layer on top. Smallest files, but vectors and fonts are not kept.',
  optimize:
    'Keeps the original text and vector artwork, recompressing only the images embedded in the page.',
};

export function isPreset(value: unknown): value is Preset {
  return typeof value === 'string' && (PRESET_VALUES as readonly string[]).includes(value);
}

export function isStrategy(value: unknown): value is Strategy {
  return typeof value === 'string' && (STRATEGY_VALUES as readonly string[]).includes(value);
}

/**
 * Expands a preset into the concrete values a job runs with. `high` and
 * `balanced` are fixed recipes; `custom` uses whatever the user configured.
 * `recognizeText` is always taken from the live settings.
 */
export function resolveSettings(settings: Settings): ResolvedSettings {
  if (settings.preset === 'high') {
    return {
      preset: 'high',
      strategy: 'flatten',
      dpi: 96,
      jpegQuality: 78,
      recognizeText: settings.recognizeText,
    };
  }
  if (settings.preset === 'custom') {
    return {
      preset: 'custom',
      strategy: settings.strategy,
      dpi: settings.dpi,
      jpegQuality: settings.jpegQuality,
      recognizeText: settings.recognizeText,
    };
  }
  return {
    preset: 'balanced',
    strategy: 'optimize',
    dpi: 96,
    jpegQuality: 78,
    recognizeText: settings.recognizeText,
  };
}

/** Merge unknown persisted data onto the defaults, dropping invalid enum values. */
export function normalizeStoredSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
  const stored = raw as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    preset: isPreset(stored.preset) ? stored.preset : DEFAULT_SETTINGS.preset,
    strategy: isStrategy(stored.strategy) ? stored.strategy : DEFAULT_SETTINGS.strategy,
  };
}
