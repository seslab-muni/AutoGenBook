/**
 * Validates a `?redirect=` search param before navigating to it. `redirect` is attacker-
 * controllable (it's whatever the URL bar contains), so anything that isn't unambiguously a
 * same-origin relative path is rejected in favor of `/` — in particular `//evil.com` and
 * `/\evil.com`, which some browsers treat as protocol-relative/scheme-relative URLs even though
 * they start with a single leading char that looks safe.
 */
export function getSafeRedirectTarget(redirect: string | undefined): string {
  if (!redirect) return '/';
  if (!redirect.startsWith('/')) return '/';
  if (redirect.startsWith('//') || redirect.startsWith('/\\')) return '/';
  return redirect;
}
