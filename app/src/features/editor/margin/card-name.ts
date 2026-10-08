import { reviewPayload, reviewTypeLabel } from '@/features/editor/lib/card-payloads';
import { cardKind } from './card-registry';
import type { MarginThread } from './threads';

/** Short label for the card region, read by screen readers: "Comment by Ada on “quote”". */
export function cardRegionName(thread: MarginThread): string {
  return describeCard(thread, cardKind(thread.kind).label);
}

function describeCard(thread: MarginThread, label: string): string {
  if (thread.kind === 'review') {
    // Reviewer cards have no author; what tells them apart is the issue itself.
    const payload = reviewPayload(thread.root);
    const text = thread.root.bodyMarkdown;
    const gist = text.length > 50 ? `${text.slice(0, 50)}…` : text;
    return `Review issue, ${payload.severity} ${reviewTypeLabel(payload.type)}: ${gist}`;
  }
  const author = thread.root.authorName;
  const head = `${label}${author ? ` by ${author}` : ''}`;
  if (thread.sectionLevel) return `${head} on the whole section`;
  // By code point: a UTF-16 slice could cut an astral character in half.
  const points = Array.from(thread.quote);
  const quote = points.length > 60 ? `${points.slice(0, 60).join('')}…` : thread.quote;
  return `${head}${thread.orphaned ? ' (orphaned)' : ''} on “${quote}”`;
}
