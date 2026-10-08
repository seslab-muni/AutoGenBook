import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { useDeleteCommentMutation } from '@/api/queries/comments';
import { useRejectSuggestionMutation } from '@/api/queries/revisions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';
import { describeStartError, type CopilotFailure } from './copilot-errors';
import type { DraftCardProps } from './composer-registry';
import { DRAFT_ID, draftKey, noChips, useMarginStore, type PromptChips } from './margin-store';
import {
  anyChip,
  buildRevisionRequest,
  countSentences,
  MAX_INSTRUCTION_LENGTH,
  threadsInScope,
} from './prompt-request';

function Chip({
  pressed,
  disabled,
  title,
  onToggle,
  children,
}: {
  pressed: boolean;
  disabled?: boolean | undefined;
  title?: string | undefined;
  onToggle: () => void;
  children: string;
}) {
  const button = (
    <button
      type="button"
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onToggle}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors outline-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'bg-background text-foreground hover:bg-accent',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-background',
      )}
    >
      {pressed ? <span aria-hidden="true">✓ </span> : null}
      {children}
    </button>
  );
  if (!title) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The prompt window, as a card in the margin (issue #182 phase 4): one window for the selection
 * toolbar's `Prompt…`, the header's Copilot button and Try again. The scope is fixed by where it
 * was opened (the selected range, or the whole section); the instruction, the chips and the verb
 * are the request. Unsent text lives in the margin store, so it survives the card unmounting (the
 * narrow side sheet closing); `Ctrl+Enter` sends, `Escape` closes, focus goes in on open and back
 * to where the window came from on close.
 */
export function PromptDraftCard({
  draft,
  ctx,
  top,
  register,
  quote,
  threads,
  range,
}: DraftCardProps) {
  const prompt = draft.kind === 'prompt' ? draft : null;
  const closeComposer = useMarginStore((state) => state.closeComposer);
  const updatePrompt = useMarginStore((state) => state.updatePrompt);
  const setDraftText = useMarginStore((state) => state.setDraftText);
  const clearDraftText = useMarginStore((state) => state.clearDraftText);
  const key = draftKey(ctx.nodeId, 'prompt');
  const stored = useMarginStore((state) => state.drafts[key]);
  const [error, setError] = useState<CopilotFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const ref = useCallback((element: HTMLElement | null) => register(DRAFT_ID, element), [register]);
  const hintId = useId();
  const errorId = useId();
  const reject = useRejectSuggestionMutation(ctx.projectId, ctx.nodeId);
  const dismiss = useDeleteCommentMutation(ctx.projectId, ctx.nodeId);
  const openModal = useUiStore((state) => state.openModal);

  const anchor = prompt?.anchor ?? null;
  const sectionScope = anchor === null;
  const chips = prompt?.chips ?? noChips();
  const verb = prompt?.verb ?? 'revise';
  const text = stored ?? '';
  const issues = useMemo(
    () => threadsInScope(threads, 'review', range, sectionScope),
    [threads, range, sectionScope],
  );
  const comments = useMemo(
    () => threadsInScope(threads, 'comment', range, sectionScope),
    [threads, range, sectionScope],
  );
  const rewriteBlocked = !sectionScope
    ? 'Rewrite drafts the whole section again; it cannot be limited to a selection.'
    : prompt?.threadId
      ? 'Rewrite cannot answer a comment thread.'
      : anyChip(chips)
        ? 'Rewrite takes only an instruction: turn the options off first.'
        : null;
  const chipsLocked = verb === 'rewrite';
  const nothingToDo =
    verb === 'revise' && text.trim() === '' && !anyChip(chips) && !prompt?.threadId;

  // Focus goes into the window when it opens (the user just asked for it), and back out on close.
  // The card is hidden until the margin has laid it out (`top`), and a hidden element cannot take
  // focus, so this waits for that.
  const focused = useRef(false);
  const laidOut = top !== undefined;
  useEffect(() => {
    if (!laidOut || focused.current) return;
    focused.current = true;
    textarea.current?.focus();
    const length = textarea.current?.value.length ?? 0;
    textarea.current?.setSelectionRange(length, length);
  }, [laidOut]);

  function close(clear: boolean) {
    if (clear) clearDraftText(key);
    closeComposer();
    // Back to what opened it: the header button, else the text.
    const origin = prompt?.origin;
    requestAnimationFrame(() => {
      const trigger =
        origin === 'header' ? document.querySelector<HTMLElement>('[data-copilot-trigger]') : null;
      if (trigger) trigger.focus();
      else ctx.restoreEditorFocus();
    });
  }

  const submit = async () => {
    if (!prompt || inFlight.current || nothingToDo || !ctx.startRevision) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const request = buildRevisionRequest({
        verb,
        anchor,
        instruction: text.trim(),
        threadId: prompt.threadId,
        chips,
        fixIssueIds: issues.map((thread) => thread.id),
        addressCommentIds: comments.map((thread) => thread.id),
      });
      await ctx.startRevision(request, { moveFocus: true });
      // Try again: the new request replaces the suggestion it was made from.
      const replaced = prompt.replaces;
      if (replaced) {
        if (replaced.status === 'pending') reject.mutate(replaced.id);
        else dismiss.mutate(replaced.id);
      }
      clearDraftText(key);
      closeComposer();
    } catch (failure) {
      setError(describeStartError(failure));
      inFlight.current = false;
      setBusy(false);
    }
  };

  function toggle(patch: Partial<PromptChips>) {
    updatePrompt({ chips: { ...chips, ...patch } });
  }

  if (!prompt) return null;
  const sentences = countSentences(quote ?? '');
  const scopeLabel = sectionScope
    ? `Section §${ctx.sectionNumber ?? ''}`.trim()
    : `Selection · ${sentences} ${sentences === 1 ? 'sentence' : 'sentences'}`;

  return (
    <section
      ref={ref}
      aria-label="Prompt the copilot"
      data-kind="draft"
      data-focused
      className={cn(
        '@container absolute inset-x-3 rounded-lg border border-ring bg-card p-3 text-card-foreground shadow-md',
        top === undefined && 'invisible',
      )}
      style={{ top: top ?? 0 }}
      // Anywhere in the window (a chip has focus after a click): Ctrl+Enter sends, Escape closes.
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void submit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) close(true);
        }
      }}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Sparkles className="size-3.5 text-muted-foreground" aria-hidden="true" />
          Copilot
        </span>
        <span className="rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium">
          {scopeLabel}
        </span>
      </header>
      {quote ? (
        <blockquote className="mb-2 line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground italic">
          {quote}
        </blockquote>
      ) : null}
      <Textarea
        ref={textarea}
        aria-label="Instruction for the copilot"
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error ? true : undefined}
        placeholder={
          verb === 'rewrite'
            ? 'How should the section be drafted again?'
            : 'Tell the copilot what to change… e.g. “add a short proof”'
        }
        maxLength={MAX_INSTRUCTION_LENGTH}
        value={text}
        readOnly={busy}
        className="min-h-20 bg-background text-sm"
        onChange={(event) => setDraftText(key, event.target.value)}
      />
      <div role="group" aria-label="Options" className="mt-2 flex flex-wrap gap-1.5">
        <Chip
          pressed={chips.moreProofs}
          disabled={chipsLocked}
          onToggle={() => toggle({ moreProofs: !chips.moreProofs })}
        >
          more proofs
        </Chip>
        <Chip
          pressed={chips.moreExamples}
          disabled={chipsLocked}
          onToggle={() => toggle({ moreExamples: !chips.moreExamples })}
        >
          more examples
        </Chip>
        <Chip
          pressed={chips.moreRigorous}
          disabled={chipsLocked}
          onToggle={() => toggle({ moreRigorous: !chips.moreRigorous })}
        >
          more rigorous
        </Chip>
        <Chip
          pressed={chips.length === 'shorter'}
          disabled={chipsLocked}
          onToggle={() => toggle({ length: chips.length === 'shorter' ? null : 'shorter' })}
        >
          shorter
        </Chip>
        <Chip
          pressed={chips.length === 'longer'}
          disabled={chipsLocked}
          onToggle={() => toggle({ length: chips.length === 'longer' ? null : 'longer' })}
        >
          longer
        </Chip>
        <Chip
          pressed={chips.citeSources}
          disabled={chipsLocked}
          onToggle={() => toggle({ citeSources: !chips.citeSources })}
        >
          cite sources
        </Chip>
        <Chip
          pressed={chips.fixIssues}
          disabled={chipsLocked || issues.length === 0}
          title={issues.length === 0 ? 'No open review issues in this scope' : undefined}
          onToggle={() => toggle({ fixIssues: !chips.fixIssues })}
        >
          {`fix ${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}
        </Chip>
        <Chip
          pressed={chips.addressComments}
          disabled={chipsLocked || comments.length === 0}
          title={comments.length === 0 ? 'No open comments in this scope' : undefined}
          onToggle={() => toggle({ addressComments: !chips.addressComments })}
        >
          {`address ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
        </Chip>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <ToggleGroup
          aria-label="What the copilot does"
          value={verb}
          onValueChange={(value) => {
            if (value === 'rewrite' && rewriteBlocked) return;
            updatePrompt({ verb: value as 'revise' | 'rewrite' });
          }}
          className="h-7"
        >
          <ToggleGroupItem value="revise" className="px-2 text-xs">
            Revise
          </ToggleGroupItem>
          <ToggleGroupItem
            value="rewrite"
            className="px-2 text-xs"
            aria-disabled={rewriteBlocked ? true : undefined}
            title={rewriteBlocked ?? 'Draft the section again from its brief'}
          >
            Rewrite
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="text-[11px] text-muted-foreground">
          {verb === 'revise'
            ? 'Keeps your text and applies the request'
            : 'Drafts the section again'}
        </span>
      </div>
      {error ? (
        <div id={errorId} role="alert" className="mt-2 text-xs text-destructive">
          <p>{error.message}</p>
          {error.code === 'llm_key_required' ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs"
              onClick={() => openModal('account')}
            >
              Account settings
            </Button>
          ) : null}
          {error.code === 'section_too_large' ? (
            <p className="text-muted-foreground">
              Select a passage in the text, then choose Prompt….
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span id={hintId} className="text-[11px] text-muted-foreground">
          Ctrl+Enter to send · Esc to close
        </span>
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => close(true)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={busy || nothingToDo || !ctx.startRevision}
            onClick={() => void submit()}
          >
            {busy ? 'Sending…' : verb === 'rewrite' ? 'Rewrite' : 'Revise'}
          </Button>
        </div>
      </div>
    </section>
  );
}
