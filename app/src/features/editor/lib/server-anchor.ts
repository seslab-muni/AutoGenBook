import type { CommentAnchorIn } from '@/api/types';
import { codePointLength } from './anchors';

interface AnchorLike {
  quote?: string | null | undefined;
  prefix?: string | null | undefined;
  suffix?: string | null | undefined;
  start?: number | null | undefined;
  end?: number | null | undefined;
}

/**
 * An anchor as the API accepts one (`CommentAnchorIn`: a non-empty `quote`; `start` and `end` both set
 * with `end - start` equal to the quote's length in code points, or both null; nothing else), or `null`
 * when there is nothing to send: an empty quote is a 422 on the real server.
 *
 * `omitOffsets` is for a section whose stored text has CR LF line endings: the editor counts LF, so
 * its offsets would point at the wrong place in the stored text. The server then resolves the quote
 * (with its context) by itself.
 */
export function toServerAnchor(
  anchor: AnchorLike | null | undefined,
  { omitOffsets = false }: { omitOffsets?: boolean } = {},
): CommentAnchorIn | null {
  const quote = anchor?.quote ?? '';
  if (!anchor || quote === '') return null;
  const { start, end } = anchor;
  const consistent =
    !omitOffsets &&
    typeof start === 'number' &&
    typeof end === 'number' &&
    end - start === codePointLength(quote);
  return {
    quote,
    prefix: anchor.prefix ?? '',
    suffix: anchor.suffix ?? '',
    start: consistent ? start! : null,
    end: consistent ? end! : null,
  };
}
