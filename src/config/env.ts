/**
 * Runtime configuration, validated once at module load so a bad value fails
 * loudly here instead of somewhere deep in the UI.
 */

export interface Env {
  /** Shown in the workspace footer. */
  APP_VERSION: string;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function loadEnv(): Env {
  return {
    // `__APP_VERSION__` is injected from package.json at build time (see
    // vite.config.ts); the env var stays available as a deploy-time override.
    APP_VERSION: coerceString(import.meta.env.VITE_APP_VERSION, __APP_VERSION__),
  };
}

export const env: Env = loadEnv();
