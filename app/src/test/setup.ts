import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import { seedDatabase } from '@/mocks/fixtures';
import { server } from '@/mocks/server';

/** jsdom has no `matchMedia`; `next-themes` (system theme detection) queries it on mount. */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** jsdom has no `ResizeObserver`; Radix's `Select` measures its trigger/viewport with one. */
if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => seedDatabase());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
