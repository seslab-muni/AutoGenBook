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

/** jsdom has no Pointer Capture APIs; Radix's `Select` calls these on pointer/click events. */
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {};
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

/** jsdom has no `ResizeObserver`; Radix's `Select` measures its trigger/viewport with one. */
if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * jsdom has no layout engine, so `Range.getClientRects()`/`getBoundingClientRect()` are
 * unimplemented; CodeMirror 6 (`SectionEditor`) calls these to measure cursor/selection
 * position on click and keyboard input.
 */
if (typeof document.createRange === 'function') {
  const range = document.createRange();
  if (typeof range.getClientRects !== 'function' || range.getClientRects().length === 0) {
    Range.prototype.getClientRects = function getClientRects(): DOMRectList {
      const list: DOMRectList = {
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* (): ArrayIterator<DOMRect> {},
      };
      return list;
    };
  }
  Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this;
    },
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => seedDatabase());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
