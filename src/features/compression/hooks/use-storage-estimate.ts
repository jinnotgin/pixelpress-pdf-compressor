import { useCallback, useState } from 'react';

import { formatBytes } from '@/utils/format';

import { readStorageUsage, type StorageUsage } from '../services/storage-usage';

interface StorageEstimateState {
  storageText: string;
  usage: StorageUsage | null;
  refresh: () => Promise<void>;
}

/** Reports how much of the browser storage quota this origin is using. */
export function useStorageEstimate(): StorageEstimateState {
  const [storageText, setStorageText] = useState('Checking private storage');
  const [usage, setUsage] = useState<StorageUsage | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await readStorageUsage();
      if (!next) {
        setUsage(null);
        setStorageText('Private storage unavailable');
        return;
      }
      setUsage(next);
      setStorageText(`${formatBytes(next.usage)} used of ${formatBytes(next.quota)} browser storage`);
    } catch {
      setUsage(null);
      setStorageText('Private storage estimate unavailable');
    }
  }, []);

  return { storageText, usage, refresh };
}
