/**
 * Line endings as the editor sees them: CodeMirror normalises CR LF (and lone CR) to LF, so the
 * draft, the highlights and every anchor offset are counted over LF text. A section that arrives
 * with CR LF is normalised on load; it is saved as LF the first time it is edited.
 */
export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}
