/**
 * Which link targets the Write view will make or keep as links (issue #182, phase 5): `http:`,
 * `https:`, `mailto:`, relative addresses and `#` fragments. Anything with another scheme
 * (`javascript:`, `data:`, `vbscript:`, `file:`...) is refused wherever a link can come from - the
 * link shortcut, pasted HTML, and links parsed from the Markdown source (those are drawn without
 * an `href`, not rewritten).
 */
// Characters a browser ignores inside a scheme (a tab inside `javascript:` is still `javascript:`).
// eslint-disable-next-line no-control-regex
const IGNORED = /[\u0000-\u0020\u007f-\u009f\u200b-\u200d\u2028\u2029\ufeff]/g;

export function isSafeHref(href: string): boolean {
  const squeezed = href.replace(IGNORED, '');
  if (squeezed === '') return true;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(squeezed)?.[1]?.toLowerCase();
  if (scheme === undefined) return true;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}
