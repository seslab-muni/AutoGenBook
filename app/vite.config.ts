/// <reference types="vitest/config" />
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      // Route-level tests (e.g. `p.$projectId.runs.$runId.test.tsx`) live alongside their route
      // module rather than off in a mirrored test tree, so exclude test files from route scanning.
      routeFileIgnorePattern: '\\.test\\.[jt]sx?$',
    }),
    react(),
    tailwindcss(),
    // Emits `dist/bundle-stats.json` on every `pnpm build`, consumed by
    // `scripts/check-bundle-budget.mjs` (CI's bundle-budget step, issue #23) - kept
    // unconditional rather than gated behind an env var so the budget check never
    // silently no-ops from a missing report.
    visualizer({
      template: 'raw-data',
      filename: 'dist/bundle-stats.json',
      gzipSize: true,
    }) as import('vite').PluginOption,
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    // `scripts/check-bundle-budget.mjs` reads `dist/.vite/manifest.json`'s
    // `isEntry` flag to find the eagerly-loaded entry chunk (as opposed to a
    // route chunk only fetched on navigation) among `dist/bundle-stats.json`'s
    // per-chunk sizes.
    manifest: true,
  },
  server: {
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/msw-polyfills.ts', './src/test/setup.ts'],
    css: true,
    exclude: ['node_modules', 'dist', 'e2e'],
    // Above Vitest's own 5000ms default so a busy CI runner has room to actually honor the
    // `asyncUtilTimeout` bump in `src/test/setup.ts` (a test with a couple of sequential async
    // queries, each individually still under that budget, could otherwise still hit Vitest's own
    // per-test wall clock first). A handful of tests with an unusually long real-timer critical
    // path (e.g. `export-dialog.test.tsx`'s "builds a PDF..." test) still set their own higher
    // per-test override where even this isn't enough headroom.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['src/routeTree.gen.ts', 'src/components/ui/**'],
    },
  },
});
