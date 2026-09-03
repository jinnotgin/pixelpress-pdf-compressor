import { type ReactNode } from 'react';

import { ErrorBoundary } from 'react-error-boundary';

import { AppErrorFallback } from './error-fallback';

interface AppProviderProps {
  children: ReactNode;
}

/**
 * Global providers. Today that is just a top-level error boundary; add context
 * providers, query clients, etc. here as the app grows.
 */
export function AppProvider({ children }: AppProviderProps) {
  return (
    <ErrorBoundary
      FallbackComponent={AppErrorFallback}
      onReset={() => window.location.reload()}
    >
      {children}
    </ErrorBoundary>
  );
}
