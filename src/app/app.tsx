import { CompressionApp } from '@/features/compression';

import { AppProvider } from './provider';

/**
 * Composition root. The app has a single view (the compressor), so there is no
 * router layer — just providers wrapping the one feature entry point.
 */
export function App() {
  return (
    <AppProvider>
      <CompressionApp />
    </AppProvider>
  );
}
