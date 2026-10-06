/**
 * Recovers a tab that is still running the previous build after a deploy.
 *
 * Every deploy replaces the hashed asset files under `/assets/`, so a tab that loaded the
 * app before the deploy asks for chunks that no longer exist the next time it navigates to a
 * route (or a component) it hasn't loaded yet. nginx now answers those with a 404
 * (`app/nginx.conf.template`), which reaches the page in two ways:
 *
 * - the route module itself fails to import: TanStack Router's `lazyRouteComponent` already
 *   recognises that error and reloads the page once (guarded with `sessionStorage`), so it
 *   needs no help here;
 * - a dependency the route module preloads fails (a shared chunk or a stylesheet): Vite's
 *   preload helper dispatches `vite:preloadError` on `window` and, unless the event is
 *   `preventDefault`ed, rethrows the error into the route load, where the router does *not*
 *   recognise it and renders the error screen instead.
 *
 * Handling the event closes that second gap the way Vite's own docs recommend: reload, so the
 * browser fetches the current `index.html` (served with `Cache-Control: no-cache`, so it is
 * always revalidated) and with it the current asset URLs. The reload is attempted once per
 * failing asset per tab; if it fails again the error propagates as before, so a genuinely
 * broken deploy shows an error instead of reloading forever.
 */

export const STALE_BUILD_RELOAD_KEY_PREFIX = 'autogenbook:stale-build-reload:';

export interface StaleBuildRecoveryDeps {
  reload: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
}

/**
 * Decides whether a failed asset preload should trigger a page reload. Exported for tests;
 * `installStaleBuildRecovery` is the only production caller.
 */
export function shouldReloadForPreloadError(
  failedAsset: string,
  storage: StaleBuildRecoveryDeps['storage'],
): boolean {
  if (!storage) return false;
  const key = `${STALE_BUILD_RELOAD_KEY_PREFIX}${failedAsset}`;
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, '1');
    return true;
  } catch {
    // Storage unavailable (private mode quota, disabled cookies): without a loop guard a
    // reload could repeat indefinitely, so leave the error to propagate instead.
    return false;
  }
}

function describeFailedAsset(payload: unknown): string {
  if (payload instanceof Error) return payload.message;
  return String(payload);
}

export function installStaleBuildRecovery(
  deps: StaleBuildRecoveryDeps = {
    reload: () => window.location.reload(),
    storage: typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
  },
): () => void {
  const onPreloadError = (event: Event): void => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (shouldReloadForPreloadError(describeFailedAsset(payload), deps.storage)) {
      event.preventDefault();
      deps.reload();
    }
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}
