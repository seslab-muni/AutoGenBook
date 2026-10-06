import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installStaleBuildRecovery,
  shouldReloadForPreloadError,
  STALE_BUILD_RELOAD_KEY_PREFIX,
} from './stale-build';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function dispatchPreloadError(payload: unknown): Event {
  const event = new Event('vite:preloadError', { cancelable: true });
  Object.assign(event, { payload });
  window.dispatchEvent(event);
  return event;
}

describe('shouldReloadForPreloadError', () => {
  it('reloads once per failing asset and never again for the same one', () => {
    const storage = memoryStorage();

    expect(shouldReloadForPreloadError('/assets/a-OLD.js', storage)).toBe(true);
    expect(storage.data.get(`${STALE_BUILD_RELOAD_KEY_PREFIX}/assets/a-OLD.js`)).toBe('1');
    expect(shouldReloadForPreloadError('/assets/a-OLD.js', storage)).toBe(false);
    // A different asset failing is a new situation, not the same loop.
    expect(shouldReloadForPreloadError('/assets/b-OLD.js', storage)).toBe(true);
  });

  it('does not reload without a storage to guard against loops', () => {
    expect(shouldReloadForPreloadError('/assets/a-OLD.js', undefined)).toBe(false);
  });

  it('does not reload when storage throws', () => {
    const storage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {},
    };
    expect(shouldReloadForPreloadError('/assets/a-OLD.js', storage)).toBe(false);
  });
});

describe('installStaleBuildRecovery', () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it("reloads and swallows Vite's preload error the first time an asset fails", () => {
    const reload = vi.fn();
    uninstall = installStaleBuildRecovery({ reload, storage: memoryStorage() });

    const event = dispatchPreloadError(new Error('Unable to preload CSS for /assets/x-OLD.css'));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets the error propagate when the same asset fails again after a reload', () => {
    const reload = vi.fn();
    uninstall = installStaleBuildRecovery({ reload, storage: memoryStorage() });
    const error = new Error('Unable to preload CSS for /assets/x-OLD.css');

    dispatchPreloadError(error);
    const second = dispatchPreloadError(error);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
  });

  it('stops listening once uninstalled', () => {
    const reload = vi.fn();
    const stop = installStaleBuildRecovery({ reload, storage: memoryStorage() });
    stop();

    dispatchPreloadError(new Error('Unable to preload CSS for /assets/y-OLD.css'));

    expect(reload).not.toHaveBeenCalled();
  });
});
