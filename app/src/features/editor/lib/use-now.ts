import { useSyncExternalStore } from 'react';

/** One interval for every relative time on the page, however many cards are showing them. */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time, refreshed every 30 seconds (shared), for "5 min ago" labels that keep ticking. */
export function useNow(): Date {
  const value = useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
  return new Date(value);
}
