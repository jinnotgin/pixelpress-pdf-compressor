/**
 * Public surface of the compression feature. Nothing outside this folder should
 * import from its internals directly (enforced by `import/no-restricted-paths`).
 */
export { CompressionApp } from './components/compression-app';
export type { Job, Settings } from './types';
