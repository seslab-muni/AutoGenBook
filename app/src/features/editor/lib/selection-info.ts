import { CodePointIndex } from './anchors';
import type { EditorSelection } from '@/stores/editor-selection-store';

/** An `EditorSelection` (code points, 1-based line/column of the head) for UTF-16 offsets over `text`. */
export function selectionInfo(
  text: string,
  fromUnit: number,
  toUnit: number,
  headUnit: number,
): EditorSelection {
  const index = new CodePointIndex(text);
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < headUnit; i = text.indexOf('\n', i + 1)) {
    line += 1;
    lineStart = i + 1;
  }
  return {
    from: index.toCp(fromUnit),
    to: index.toCp(toUnit),
    line,
    column: index.toCp(headUnit) - index.toCp(lineStart) + 1,
  };
}
