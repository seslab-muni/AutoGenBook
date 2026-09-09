import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end/a11y smoke suite (issue #23) - runs against the real Docker Compose stack
 * (`docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait`), with the CLI
 * subprocess swapped for `tests/api/fake_cli.py` so no LLM key is needed. Not run by `pnpm test`
 * (that's Vitest, against MSW) - see `pnpm e2e` / `.github/workflows/web.yml`'s `e2e` job.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    // The header actions this suite drives (Sources/Export/Settings) hide their text label below
    // the `lg` breakpoint (see app-header.tsx) - a narrower default viewport would leave those
    // buttons with no accessible name at all.
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
