/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** App version injected from package.json by vite.config.ts `define`. */
declare const __APP_VERSION__: string;
