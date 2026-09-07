import js from '@eslint/js';
import queryPlugin from '@tanstack/eslint-plugin-query';
import routerPlugin from '@tanstack/eslint-plugin-router';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      '_reference',
      'src/routeTree.gen.ts',
      // Generated/vendored via `pnpm dlx shadcn add` — not hand-edited, so not
      // held to the app's lint rules (matches shadcn/ui's own recommendation).
      'src/components/ui',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      '@tanstack/query': queryPlugin,
      '@tanstack/router': routerPlugin,
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      ...reactRefresh.configs.vite.rules,
      ...queryPlugin.configs.recommended.rules,
      ...routerPlugin.configs.recommended.rules,
    },
  },
  {
    files: ['**/*.config.{ts,js}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Route modules only ever export `Route`; the component lives on
    // `Route.component` rather than as its own export.
    files: ['src/routes/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
);
