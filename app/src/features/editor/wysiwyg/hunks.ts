import { diffChange, type TextChange } from '@/features/editor/lib/anchors';

/**
 * The changes that turn `before` into `after` as separate hunks (issue #182, phase 5), in the
 * coordinates of `before`, ascending and not touching each other. When the editor writes a block
 * again, most of its text is unchanged: telling the hunks apart is what keeps an anchor on text
 * that did not change where it was (one hunk for the whole block would swallow it) - the Source
 * view's change sets are made of such hunks.
 *
 * The hunks are those of a longest common subsequence of characters, found after trimming the common
 * ends, and for texts too large for that table, first of lines and then of the characters of the
 * lines that differ. Past a budget the changed stretch is one hunk (never wrong, only coarser).
 */

const MAX_CELLS = 4_000_000;

/** Hunks of `a` -> `b` by a table of the longest common subsequence; `null` when too large. */
function lcsHunks<T>(a: readonly T[], b: readonly T[], at: number): TextChange[] | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS || Math.min(n, m) > 65000) return null;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const out: TextChange[] = [];
  let cur: TextChange | null = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < m && (i === n || dp[i * width + j + 1]! >= dp[(i + 1) * width + j]!)) {
      cur ??= { from: at + i, to: at + i, insertedLength: 0 };
      cur.insertedLength += 1;
      j += 1;
    } else {
      cur ??= { from: at + i, to: at + i, insertedLength: 0 };
      cur.to = at + i + 1;
      i += 1;
    }
  }
  flush();
  return out;
}

function lines(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', at)) {
    out.push(text.slice(at, i + 1));
    at = i + 1;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function coarse(a: string, b: string, at: number): TextChange[] {
  const change = diffChange(a, b);
  return change
    ? [{ from: at + change.from, to: at + change.to, insertedLength: change.insertedLength }]
    : [];
}

const chars = (text: string) => Array.from({ length: text.length }, (_, i) => text[i]!);

/** Hunks over characters, or the one coarse hunk past the table's budget. */
function charHunks(a: string, b: string, at: number): TextChange[] {
  if (a === '' || b === '') return coarse(a, b, at);
  return lcsHunks(chars(a), chars(b), at) ?? coarse(a, b, at);
}

export function diffHunks(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p += 1;
  let s = 0;
  while (
    s < max - p &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  ) {
    s += 1;
  }
  const a = before.slice(p, before.length - s);
  const b = after.slice(p, after.length - s);
  if (a === '' || b === '') return coarse(a, b, p);
  if ((a.length + 1) * (b.length + 1) <= MAX_CELLS) return charHunks(a, b, p);
  // Too large for characters: lines first, then the characters of the lines that differ.
  const la = lines(a);
  const lb = lines(b);
  const byLine = lcsHunks(la, lb, 0);
  if (!byLine) return coarse(a, b, p);
  const startsA = [0];
  for (const line of la) startsA.push(startsA[startsA.length - 1]! + line.length);
  const out: TextChange[] = [];
  // `byLine` is in lines of `a`; where its lines are in `b` follows from the lines each hunk adds.
  let shift = 0;
  for (const hunk of byLine) {
    const bFrom = hunk.from + shift;
    const bTo = bFrom + hunk.insertedLength;
    out.push(
      ...charHunks(
        la.slice(hunk.from, hunk.to).join(''),
        lb.slice(bFrom, bTo).join(''),
        p + startsA[hunk.from]!,
      ),
    );
    shift += hunk.insertedLength - (hunk.to - hunk.from);
  }
  return out;
}
