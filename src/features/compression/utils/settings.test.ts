import { describe, expect, it } from 'vitest';

import { type Settings } from '../types';
import { DEFAULT_SETTINGS, normalizeStoredSettings, resolveSettings } from './settings';

describe('resolveSettings', () => {
  it('expands the auto preset to a fixed automatic recipe', () => {
    const resolved = resolveSettings({
      ...DEFAULT_SETTINGS,
      preset: 'auto',
      flattenDpi: 300,
      imageDetail: 'print',
    });
    expect(resolved).toMatchObject({
      preset: 'auto',
      strategy: 'auto',
      flattenDpi: 96,
      imageDetail: 'screen',
      jpegQuality: 78,
    });
  });

  it('expands the Figma preset to a fixed flatten recipe', () => {
    const resolved = resolveSettings({ ...DEFAULT_SETTINGS, preset: 'figma', strategy: 'optimize' });
    expect(resolved).toMatchObject({ preset: 'figma', strategy: 'flatten', flattenDpi: 96 });
  });

  it('passes custom values through untouched', () => {
    const custom: Settings = {
      preset: 'custom',
      strategy: 'optimize',
      flattenDpi: 133,
      imageDetail: 'compact',
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

  it('keeps stored resolutions and image steps', () => {
    const result = normalizeStoredSettings({ flattenDpi: 96, imageDetail: 'print' });
    expect(result.flattenDpi).toBe(96);
    expect(result.imageDetail).toBe('print');
  });

  it('falls back to the default image step for an unknown one', () => {
    expect(normalizeStoredSettings({ imageDetail: 'ultra' }).imageDetail).toBe(
      DEFAULT_SETTINGS.imageDetail,
    );
  });

  it('migrates the retired presets', () => {
    expect(normalizeStoredSettings({ preset: 'high' }).preset).toBe('figma');
    expect(normalizeStoredSettings({ preset: 'balanced' }).preset).toBe('auto');
  });
});
