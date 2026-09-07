import { EventSource } from 'eventsource';

/**
 * jsdom has no `EventSource`. `msw`'s `sse()` handler only feature-detects
 * its existence at registration time (`src/mocks/handlers.ts`'s `sse(...)`
 * call, evaluated when `src/mocks/server.ts` is imported) — real SSE traffic
 * in tests goes through `subscribeRunEvents`'s injectable fake instead
 * (`src/api/sse.test.ts`), so this polyfill only needs to exist, not work
 * end-to-end. Must run before `@/mocks/server` is imported, hence its own
 * earlier entry in `vite.config.ts`'s `test.setupFiles`.
 */
if (typeof globalThis.EventSource === 'undefined') {
  globalThis.EventSource = EventSource;
}
