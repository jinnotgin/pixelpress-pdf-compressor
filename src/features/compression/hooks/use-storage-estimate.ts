import { useCallback, useState } from 'react';

import { formatBytes } from '@/utils/format';

interface StorageEstimateState {
  storageText: string;
  refresh: () => void;
}

/** Reports how much of the browser storage quota the OPFS cache is using. */
export function useStorageEstimate(): StorageEstimateState {
  const [storageText, setStorageText] = useState('Checking private storage');

  const refresh = useCallback(() => {
    if (!navigator.storage?.estimate) {
      setStorageText('Private storage unavailable');
      return;
    }
    navigator.storage
      .estimate()
      .then(({ usage, quota }) => {
        setStorageText(`${formatBytes(usage ?? 0)} used of ${formatBytes(quota ?? 0)} browser storage`);
      })
      .catch(() => setStorageText('Private storage estimate unavailable'));
  }, []);

  return { storageText, refresh };
}
