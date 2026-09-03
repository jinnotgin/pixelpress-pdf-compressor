import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dist-single', 'node_modules', 'archived', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      import: importPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      /*
       * Bulletproof-react: enforce a unidirectional dependency graph.
       * shared (components / utils / config / hooks)  <-  features  <-  app
       * and features may not reach into other features.
       */
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './src/components', from: ['./src/features', './src/app'] },
            { target: './src/hooks', from: ['./src/features', './src/app'] },
            { target: './src/utils', from: ['./src/features', './src/app'] },
            { target: './src/config', from: ['./src/features', './src/app'] },
            { target: './src/features', from: './src/app' },
            {
              target: './src/features/compression',
              from: './src/features',
              except: ['./compression'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'import/no-restricted-paths': 'off',
    },
  },
);
