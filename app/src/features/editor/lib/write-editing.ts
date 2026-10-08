/**
 * The one switch for the editable Write view (issue #182, phase 5). Build-time, from
 * `VITE_WRITE_EDITING`: on unless it is `0`, `false` or `off`. When it is off the Write view is
 * exactly the read-only renderer it was before the editor existed, and the editor chunk
 * (`markdown-editor`) is never requested. Read here and nowhere else; read at call time so a test
 * can set it with `vi.stubEnv`.
 */
export function isWriteEditingEnabled(): boolean {
  const raw = import.meta.env.VITE_WRITE_EDITING;
  if (raw === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}
