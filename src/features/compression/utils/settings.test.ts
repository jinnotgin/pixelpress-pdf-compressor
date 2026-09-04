import { describe, expect, it } from 'vitest';

import { type Settings } from '../types';
import { DEFAULT_SETTINGS, normalizeStoredSettings, resolveSettings } from './settings';

describe('resolveSettings', () => {
  it('expands the auto preset to a fixed automatic recipe', () => {
    const resolved = resolveSettings({ ...DEFAULT_SETTINGS, preset: 'auto', dpi: 300 });
    expect(resolved).toMatchObject({ preset: 'auto', strategy: 'auto', dpi: 96, jpegQuality: 78 });
  });

  it('expands the Figma preset to a fixed flatten recipe', () => {
    const resolved = resolveSettings({ ...DEFAULT_SETTINGS, preset: 'figma', strategy: 'optimize' });
    expect(resolved).toMatchObject({ preset: 'figma', strategy: 'flatten', dpi: 96 });
  });

  it('passes custom values through untouched', () => {
    const custom: Settings = {
      preset: 'custom',
      strategy: 'optimize',
      dpi: 133,
      jpegQuality: 61,
      recognizeText: false,
      ocrLanguage: 'tam',
    };
    expect(resolveSettings(custom)).toEqual(custom);
  });

  it('always takes OCR preferences from the live settings', () => {
    const resolved = resolveSettings({
      ...DEFAULT_SETTINGS,
      preset: 'figma',
      recognizeText: false,
      ocrLanguage: 'chi_tra',
    });
    expect(resolved.recognizeText).toBe(false);
    expect(resolved.ocrLanguage).toBe('chi_tra');
  });
});

describe('normalizeStoredSettings', () => {
  it('falls back to defaults for garbage input', () => {
    expect(normalizeStoredSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeStoredSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('drops invalid enum values but keeps valid overrides', () => {
    const result = normalizeStoredSettings({
      preset: 'bogus',
      strategy: 'flatten',
      jpegQuality: 40,
      ocrLanguage: 'not-a-language',
    });
    expect(result.preset).toBe(DEFAULT_SETTINGS.preset);
    expect(result.strategy).toBe('flatten');
    expect(result.jpegQuality).toBe(40);
    expect(result.ocrLanguage).toBe('eng');
  });

  it('keeps a supported OCR language', () => {
    expect(normalizeStoredSettings({ ocrLanguage: 'msa' }).ocrLanguage).toBe('msa');
  });

  it('migrates the retired presets', () => {
    expect(normalizeStoredSettings({ preset: 'high' }).preset).toBe('figma');
    expect(normalizeStoredSettings({ preset: 'balanced' }).preset).toBe('auto');
  });
});
