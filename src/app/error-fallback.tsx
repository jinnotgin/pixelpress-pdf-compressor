import { type FallbackProps } from 'react-error-boundary';

export function AppErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="app-error" role="alert">
      <h1>PixelPress hit an unexpected error</h1>
      <p>{message}</p>
      <button type="button" className="primary-button" onClick={resetErrorBoundary}>
        Reload the app
      </button>
    </div>
  );
}
