import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

import { SETTINGS_STORAGE_KEY } from '../config';
import { type Settings } from '../types';
import { DEFAULT_SETTINGS, normalizeStoredSettings } from '../utils/settings';

function readStoredSettings(): Settings {
  try {
    return normalizeStoredSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}'));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export type SettingsUpdater = Dispatch<SetStateAction<Settings>>;

/** Settings state mirrored to localStorage, restored (and re-validated) on load. */
export function usePersistentSettings(): [Settings, SettingsUpdater] {
  const [settings, setSettings] = useState<Settings>(readStoredSettings);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode / quota — the form still works, it just won't persist */
    }
  }, [settings]);

  return [settings, setSettings];
}
