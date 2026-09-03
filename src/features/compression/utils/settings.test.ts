import { describe, expect, it } from 'vitest';

import { type Settings } from '../types';
import { DEFAULT_SETTINGS, normalizeStoredSettings, resolveSettings } from './settings';

describe('resolveSettings', () => {
  it('expands the high preset to a fixed flatten recipe', () => {
    const resolved = resolveSettings({ ...DEFAULT_SETTINGS, preset: 'high', dpi: 300 });
    expect(resolved).toMatchObject({ preset: 'high', strategy: 'flatten', dpi: 96, jpegQuality: 78 });
  });

  it('expands the balanced preset to a fixed optimize recipe', () => {
    const resolved = resolveSettings({ ...DEFAULT_SETTINGS, preset: 'balanced', strategy: 'flatten' });
    expect(resolved).toMatchObject({ preset: 'balanced', strategy: 'optimize', dpi: 96 });
  });

  it('passes custom values through untouched', () => {
    const custom: Settings = {
      preset: 'custom',
      strategy: 'optimize',
      dpi: 133,
      jpegQuality: 61,
      recognizeText: false,
    };
    expect(resolveSettings(custom)).toEqual(custom);
  });

  it('always takes recognizeText from the live settings', () => {
    expect(resolveSettings({ ...DEFAULT_SETTINGS, preset: 'high', recognizeText: false }).recognizeText).toBe(
      false,
    );
  });
});

describe('normalizeStoredSettings', () => {
  it('falls back to defaults for garbage input', () => {
    expect(normalizeStoredSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeStoredSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('drops invalid enum values but keeps valid overrides', () => {
    const result = normalizeStoredSettings({ preset: 'bogus', strategy: 'flatten', jpegQuality: 40 });
    expect(result.preset).toBe(DEFAULT_SETTINGS.preset);
    expect(result.strategy).toBe('flatten');
    expect(result.jpegQuality).toBe(40);
  });
});
