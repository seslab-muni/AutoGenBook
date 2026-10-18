import { afterEach } from 'vitest';

const realMatchMedia = window.matchMedia;

/**
 * Runs the rest of the test as a screen `width` px wide: `matchMedia` answers `min-width` and
 * `max-width` queries against it (the global stub in `setup.ts` pretends to be 1440px, so every
 * `min-width <= 1440` query is true). Restored after each test.
 */
export function setViewportWidth(width: number): void {
  window.matchMedia = ((query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const max = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches =
      (min ? width >= Number(min[1]) : true) && (max ? width <= Number(max[1]) : true);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
});
