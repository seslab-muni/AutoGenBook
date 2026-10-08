import { useMemo, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { buildDiffBlocks, type DiffBlock } from '@/features/editor/lib/diff-view';
import type { SuggestionPayload } from '@/features/editor/lib/card-payloads';
import { cn } from '@/lib/utils';

/** Changes shown before "Show all N changes". */
export const COLLAPSED_CHANGES = 3;
/** A change this long (removed + added characters) is clamped until the reader asks for more. */
const LONG_CHANGE = 700;

interface SuggestionDiffProps {
  payload: SuggestionPayload;
  /** The suggestion's range as code points over the original text (range scope). */
  range: { start: number; end: number } | null;
  /** Hunk indexes ticked for a partial accept; omitted = no checkboxes. */
  selected?: ReadonlySet<number> | undefined;
  onToggle?: ((hunkIndex: number) => void) | undefined;
  /** The suggestion was already accepted/rejected: no checkboxes whatever the state. */
  readOnly?: boolean | undefined;
}

function Block({
  block,
  position,
  total,
  checked,
  onToggle,
}: {
  block: DiffBlock;
  position: number;
  total: number;
  checked: boolean | undefined;
  onToggle: (() => void) | undefined;
}) {
  const long = block.removedLength + block.addedLength > LONG_CHANGE;
  const [open, setOpen] = useState(!long);
  const label = `Change ${position} of ${total}`;
  return (
    <div
      role="group"
      aria-label={label}
      data-hunk={block.hunkIndex}
      className="rounded-md border bg-background p-2"
    >
      {onToggle ? (
        <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Checkbox
            checked={checked === true}
            onCheckedChange={onToggle}
            aria-label={`Apply change ${position} of ${total}`}
          />
          {label}
        </label>
      ) : total > 1 ? (
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">{label}</p>
      ) : null}
      <p
        className={cn(
          'text-xs leading-relaxed break-words whitespace-pre-wrap',
          !open && 'max-h-28 overflow-hidden',
        )}
      >
        {block.cutBefore ? <span className="text-muted-foreground">… </span> : null}
        {block.segments.map((segment, i) =>
          segment.type === 'context' ? (
            <span key={i} className="text-muted-foreground">
              {segment.text}
            </span>
          ) : segment.type === 'removed' ? (
            <del
              key={i}
              className="rounded-sm bg-destructive/15 text-foreground decoration-destructive decoration-1"
            >
              <span className="sr-only">Removed: </span>
              {segment.text}
            </del>
          ) : (
            <ins
              key={i}
              className="rounded-sm bg-success/15 text-foreground decoration-success decoration-2 underline-offset-2"
            >
              <span className="sr-only">Added: </span>
              {segment.text}
            </ins>
          ),
        )}
        {block.cutAfter ? <span className="text-muted-foreground"> …</span> : null}
      </p>
      {long ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="mt-1 h-auto p-0 text-[11px]"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show the whole change'}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The diff of a pending suggestion, built from the API's hunks over `originalMarkdown`: removed
 * text struck through on a destructive tint, added text underlined on a success tint (so the two
 * differ without colour, and screen readers hear "Removed:" / "Added:"), each with a little
 * unchanged text around it. Only the first few changes show until "Show all N changes".
 */
export function SuggestionDiff({
  payload,
  range,
  selected,
  onToggle,
  readOnly = false,
}: SuggestionDiffProps) {
  const [expanded, setExpanded] = useState(false);
  const original = payload.originalMarkdown;
  const blocks = useMemo(
    () =>
      original === null
        ? []
        : buildDiffBlocks(original, payload.hunks, {
            range: payload.scope === 'range' ? range : null,
          }),
    [original, payload.hunks, payload.scope, range],
  );
  if (blocks.length === 0) return null;
  const shown = expanded ? blocks : blocks.slice(0, COLLAPSED_CHANGES);
  const pickable = !readOnly && payload.scope === 'section' && blocks.length > 1 && !!onToggle;
  return (
    <div className="mb-2 flex flex-col gap-1.5" aria-label="Proposed changes">
      {shown.map((block, i) => (
        <Block
          key={block.hunkIndex}
          block={block}
          position={i + 1}
          total={blocks.length}
          checked={pickable ? selected?.has(block.hunkIndex) : undefined}
          onToggle={pickable ? () => onToggle?.(block.hunkIndex) : undefined}
        />
      ))}
      {blocks.length > COLLAPSED_CHANGES ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto self-start p-0 text-[11px]"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer changes' : `Show all ${blocks.length} changes`}
        </Button>
      ) : null}
    </div>
  );
}
