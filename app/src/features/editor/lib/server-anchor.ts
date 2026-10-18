import type { CommentAnchorIn } from '@/api/types';
import { codePointLength } from './anchors';

interface AnchorLike {
  quote?: string | null | undefined;
  prefix?: string | null | undefined;
  suffix?: string | null | undefined;
  start?: number | null | undefined;
  end?: number | null | undefined;
}

const CONTEXT = 32;

/** The text as a CR LF section stores it. */
const toCrlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

/**
 * An anchor as the API accepts one (`CommentAnchorIn`: a non-empty `quote`; `start` and `end` both set
 * with `end - start` equal to the quote's length in code points, or both null; nothing else), or `null`
 * when there is nothing to send: an empty quote is a 422 on the real server.
 *
 * `crlf` is for a section the server still stores with CR LF line endings (until its first save): the
 * editor counts LF, so its offsets would point at the wrong place, and its quote and context would not
 * match the stored text across a line break. The offsets are left out, and the quote, prefix and
 * suffix get their line breaks back as CR LF (context cut to 32 code points again), so the server finds
 * the quote by itself - a repeated quote still resolves by its context.
 */
export function toServerAnchor(
  anchor: AnchorLike | null | undefined,
  { crlf = false }: { crlf?: boolean } = {},
): CommentAnchorIn | null {
  const raw = anchor?.quote ?? '';
  if (!anchor || raw === '') return null;
  const quote = crlf ? toCrlf(raw) : raw;
  let prefix = anchor.prefix ?? '';
  let suffix = anchor.suffix ?? '';
  if (crlf) {
    prefix = Array.from(toCrlf(prefix)).slice(-CONTEXT).join('');
    suffix = Array.from(toCrlf(suffix)).slice(0, CONTEXT).join('');
  }
  const { start, end } = anchor;
  const consistent =
    !crlf &&
    typeof start === 'number' &&
    typeof end === 'number' &&
    end - start === codePointLength(quote);
  return {
    quote,
    prefix,
    suffix,
    start: consistent ? start! : null,
    end: consistent ? end! : null,
  };
}
