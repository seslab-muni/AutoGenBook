/// <reference types="vitest/config" />
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
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
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
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
    exclude: ['node_modules', 'dist', '_reference'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['_reference/**', 'src/routeTree.gen.ts', 'src/components/ui/**'],
    },
  },
});
