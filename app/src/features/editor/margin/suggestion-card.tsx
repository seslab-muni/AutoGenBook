import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  CircleDot,
  Circle,
  CircleCheck,
  Loader2,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';

import { outline } from '@/api/queries/outline';
import type { Comment } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { suggestionPayload, type SuggestionPayload } from '@/features/editor/lib/card-payloads';
import { cn } from '@/lib/utils';
import type { MarginCardContext, MarginCardPartProps } from './card-registry';
import {
  describeStartError,
  describeSuggestionFailure,
  type CopilotFailure,
} from './copilot-errors';
import { DefaultQuote } from './default-parts';
import { useMarginStore } from './margin-store';
import { CommentMarkdown } from './comment-markdown';
import { SuggestionDiff } from './suggestion-diff';
import { useSelectedHunks } from './hunk-selection';
import { useSuggestionProgress } from './suggestion-progress';
import { useSuggestionActions, useUndoneSuggestions } from './use-suggestion-actions';
import type { MarginThread } from './threads';

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Ticks once a second while mounted; the elapsed time of a running revision. */
function Elapsed({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span aria-hidden="true">{formatElapsed(now - (Number.isNaN(start) ? now : start))}</span>;
}

const PILL = 'text-foreground';

export function SuggestionStatusPill({ suggestion }: { suggestion: Comment }) {
  switch (suggestion.status) {
    case 'running':
      return (
        <Badge variant="outline" className={cn(PILL, 'border-info/50 bg-info/15')}>
          <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Working ·{' '}
          <Elapsed since={suggestionPayload(suggestion).startedAt ?? suggestion.createdAt} />
        </Badge>
      );
    case 'pending':
      return (
        <Badge variant="outline" className={cn(PILL, 'border-info/50 bg-info/15')}>
          <Sparkles aria-hidden="true" />
          Ready to review
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="outline" className={cn(PILL, 'border-destructive/50 bg-destructive/15')}>
          <TriangleAlert aria-hidden="true" />
          Failed
        </Badge>
      );
    case 'accepted':
      return (
        <Badge variant="outline" className={cn(PILL, 'border-success/50 bg-success/15')}>
          <Check aria-hidden="true" />
          Accepted
        </Badge>
      );
    case 'rejected':
      return (
        <Badge variant="secondary">
          <X aria-hidden="true" />
          Rejected
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="secondary">
          <X aria-hidden="true" />
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{suggestion.status}</Badge>;
  }
}

/** Header status of a standalone suggestion card. */
export function SuggestionStatus({ thread, approximate }: MarginCardPartProps) {
  return (
    <>
      {thread.orphaned ? <Badge variant="outline">Orphaned</Badge> : null}
      {thread.sectionLevel ? <Badge variant="outline">Whole section</Badge> : null}
      {approximate && !thread.orphaned ? (
        <Badge variant="outline">Not shown in this view</Badge>
      ) : null}
      <SuggestionStatusPill suggestion={thread.root} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------

function SuggestionDiffPart({
  suggestion,
  payload,
}: {
  suggestion: Comment;
  payload: SuggestionPayload;
}) {
  const { selected, toggle } = useSelectedHunks(suggestion.id, payload.hunks.length);
  return (
    <SuggestionDiff
      payload={payload}
      // The range as it was in the original text, not the card's re-anchored one in today's text.
      range={payload.anchor}
      selected={selected}
      onToggle={toggle}
      readOnly={suggestion.status !== 'pending'}
      only={suggestion.status === 'accepted' ? (payload.appliedHunks ?? undefined) : undefined}
    />
  );
}

/** Whether there is a diff to show: hunks, with the original text or without it (a finished one from a list). */
function hasDiff(suggestion: Comment, payload: SuggestionPayload): boolean {
  return suggestion.status !== 'running' && payload.hunks.length > 0;
}

/** Quote slot of a standalone suggestion card: the diff once there is one, the targeted text while it works. */
export function SuggestionDiffQuote(props: MarginCardPartProps) {
  const suggestion = props.thread.root;
  const payload = suggestionPayload(suggestion);
  if (!hasDiff(suggestion, payload)) return <DefaultQuote {...props} />;
  return <SuggestionDiffPart suggestion={suggestion} payload={payload} />;
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

type StepState = 'done' | 'current' | 'todo';

const STEPS = [
  { stage: 'retrieve', label: 'Retrieve' },
  { stage: 'revise', label: 'Revise' },
  { stage: 'diff', label: 'Compare' },
] as const;

function stepStates(events: readonly { stage: string; payload?: unknown }[]): StepState[] {
  const done = new Set<string>();
  for (const event of events) {
    const phase = (event.payload as { phase?: unknown } | null | undefined)?.phase;
    if (phase === 'done') done.add(event.stage);
  }
  // The first step that has not finished is the one under way.
  const current = STEPS.findIndex((step) => !done.has(step.stage));
  return STEPS.map((step, i) =>
    done.has(step.stage) ? 'done' : i === current ? 'current' : 'todo',
  );
}

const STAGE_LINES: Record<string, string> = {
  retrieve: 'Looking through your sources…',
  revise: 'Revising the text…',
  diff: 'Comparing it with the original…',
};

function RunningProgress({ suggestion }: { suggestion: Comment }) {
  const events = useSuggestionProgress((state) => state.events[suggestion.id]);
  const list = events ?? [];
  const states = stepStates(list);
  const last = list[list.length - 1];
  const line = last ? (STAGE_LINES[last.stage] ?? last.message) : 'Starting…';
  const warning = [...list]
    .reverse()
    .find((event) => event.level === 'warning' || event.level === 'error');
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex items-center gap-2 text-[11px]" aria-label="Progress">
        {STEPS.map((step, i) => {
          const state = states[i]!;
          const Icon = state === 'done' ? CircleCheck : state === 'current' ? CircleDot : Circle;
          return (
            <li
              key={step.stage}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1',
                state === 'todo' ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              <Icon className="size-3" aria-hidden="true" />
              {step.label}
              <span className="sr-only">
                {state === 'done' ? ' (done)' : state === 'current' ? ' (in progress)' : ''}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{line}</p>
      {warning ? <p className="text-[11px] text-muted-foreground">{warning.message}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

function useCurrentHash(ctx: MarginCardContext): string | null | undefined {
  const { data } = useQuery({
    ...outline.node(ctx.projectId, ctx.nodeId),
    enabled: false,
    select: (node) => node.contentHash ?? null,
  });
  return data;
}

function announcement(suggestion: Comment, payload: SuggestionPayload): string {
  switch (suggestion.status) {
    case 'running':
      return 'The copilot is working on a suggestion.';
    case 'pending':
      return `Suggestion ready to review: ${payload.hunks.length} ${payload.hunks.length === 1 ? 'change' : 'changes'}.`;
    case 'failed':
      return 'The suggestion failed.';
    case 'cancelled':
      return 'The suggestion was cancelled.';
    default:
      return '';
  }
}

interface BodyProps {
  suggestion: Comment;
  thread: MarginThread;
  ctx: MarginCardContext;
  /** Rendered inside a comment thread: the diff goes above the actions here instead of in the card's quote slot. */
  inline?: boolean;
}

function SuggestionActions({ suggestion, thread, ctx }: BodyProps) {
  const payload = suggestionPayload(suggestion);
  const actions = useSuggestionActions(ctx);
  const [failure, setFailure] = useState<CopilotFailure | null>(null);
  const { selected } = useSelectedHunks(suggestion.id, payload.hunks.length);
  const currentHash = useCurrentHash(ctx);
  const [sending, setSending] = useState(false);
  // True for the whole of an action, including the save before an accept: no second click can start another.
  const [working, setWorking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const own = ctx.currentUserId !== null && suggestion.authorId === ctx.currentUserId;
  const undone = useUndoneSuggestions((state) => suggestion.id in state.ids);
  const status = suggestion.status;
  // The diff makes the card taller when the work finishes: keep the card the person is watching in view.
  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current === 'running' && status === 'pending') {
      const { focusedId, revealCard } = useMarginStore.getState();
      if (focusedId === thread.id) revealCard(thread.id);
    }
    previousStatus.current = status;
  }, [status, thread.id]);
  const total = payload.hunks.length;
  const partial = payload.scope === 'section' && total > 1 && selected.size < total;
  const nothingTicked = payload.scope === 'section' && total > 1 && selected.size === 0;
  // The model handed the text back unchanged: there is nothing to accept.
  const nothingChanged = total === 0;
  const linked =
    payload.params.fixIssueIds.length > 0 ||
    payload.params.addressCommentIds.length > 0 ||
    payload.threadId !== null;
  const summary = suggestion.bodyMarkdown || payload.summary;
  const blocked = ctx.editBlockedReason;
  const idle = !working && !actions.busy && !sending;
  // Deleting a suggestion is the author's (or anyone's, for one nobody authored).
  const canDismiss = suggestion.authorId === null || own;

  async function run(
    task: () => Promise<{ ok: true } | { ok: false; failure: CopilotFailure }>,
    leave: boolean,
  ) {
    setFailure(null);
    setWorking(true);
    const result = await task().finally(() => setWorking(false));
    if (!result.ok) setFailure(result.failure);
    // The card leaves the margin (finished suggestions are hidden by default): keep the keyboard in the text.
    else if (leave) ctx.restoreEditorFocus();
  }

  async function sendAgain() {
    if (!ctx.startRevision || working || blocked) return;
    // A range suggestion whose own range is gone must not quietly widen to the whole section: the
    // window shows the scope instead.
    const rangeLost =
      payload.scope === 'range' &&
      (suggestion.anchor?.start == null || suggestion.anchor?.end == null);
    if (rangeLost) {
      ctx.onTryAgain?.(suggestion, thread);
      return;
    }
    setSending(true);
    setFailure(null);
    try {
      const known = ctx.knownIds();
      const anchor = payload.scope === 'range' ? ctx.serverAnchor(suggestion.anchor) : null;
      if (payload.scope === 'range' && !anchor) {
        ctx.onTryAgain?.(suggestion, thread);
        return;
      }
      await ctx.startRevision({
        verb: 'revise',
        scope: anchor ? 'range' : 'section',
        ...(anchor ? { anchor } : {}),
        instruction: payload.instruction,
        // References to cards that were deleted since would be refused: drop them.
        params: {
          ...payload.params,
          fixIssueIds: payload.params.fixIssueIds.filter((id) => known.has(id)),
          addressCommentIds: payload.params.addressCommentIds.filter((id) => known.has(id)),
        },
        ...(payload.threadId && known.has(payload.threadId) ? { threadId: payload.threadId } : {}),
      });
      // The new request replaces this one.
      if (status === 'pending') await actions.rejectSuggestion(suggestion);
      else if (canDismiss) await actions.dismissSuggestion(suggestion);
    } catch (error) {
      setFailure(describeStartError(error));
    } finally {
      setSending(false);
    }
  }

  const live = (
    <span role="status" aria-live="polite" className="sr-only">
      {announcement(suggestion, payload)}
    </span>
  );

  const notice: ReactNode =
    status !== 'pending'
      ? null
      : payload.scope === 'range' && suggestion.anchor?.start == null
        ? 'The text changed since this was suggested. You can still accept it, or try again on the current text.'
        : payload.scope === 'section' &&
            currentHash &&
            payload.baseContentHash &&
            currentHash !== payload.baseContentHash
          ? 'The section was edited since this was suggested. Accepting may be refused; try again to get a fresh suggestion.'
          : null;

  const tryAgain = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs" disabled={!idle || !!blocked}>
          Try again
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => ctx.onTryAgain?.(suggestion, thread)}>
          Edit the instruction…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void sendAgain()}>Ask again as it was</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const failureNote = failure ? (
    <p role="alert" className="text-xs text-destructive-text">
      {failure.message}
    </p>
  ) : null;

  return (
    <div ref={root} className="flex flex-col gap-2">
      {live}
      {status === 'running' ? (
        <>
          {payload.instruction ? (
            <p className="text-xs text-muted-foreground italic">“{payload.instruction}”</p>
          ) : null}
          <RunningProgress suggestion={suggestion} />
          <div className="flex items-center gap-1.5">
            {own ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!idle}
                onClick={() => void run(() => actions.cancelSuggestion(suggestion), false)}
              >
                Cancel
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Started by {suggestion.authorName ?? 'a collaborator'}
              </span>
            )}
          </div>
        </>
      ) : null}

      {status === 'pending' ? (
        <>
          {summary ? <CommentMarkdown className="text-xs">{summary}</CommentMarkdown> : null}
          {payload.changesMade.length > 1 ||
          (payload.changesMade.length === 1 && payload.changesMade[0] !== summary) ? (
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {payload.changesMade.map((change, i) => (
                <li key={i}>{change}</li>
              ))}
            </ul>
          ) : null}
          {payload.warnings.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs" aria-label="Warnings">
              {payload.warnings.map((warning, i) => (
                <li key={i} className="flex items-start gap-1 text-foreground">
                  <TriangleAlert
                    className="mt-0.5 size-3 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}
          {payload.droppedCitations.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Removed unknown citations: {payload.droppedCitations.join(', ')}
            </p>
          ) : null}
          {nothingChanged ? (
            <p className="rounded-md bg-muted p-2 text-xs text-foreground">
              The copilot found nothing to change. Reject this, or try again with a different
              request.
            </p>
          ) : null}
          {notice ? (
            <p className="rounded-md bg-muted p-2 text-xs text-foreground">{notice}</p>
          ) : null}
          {blocked ? (
            <p className="rounded-md bg-muted p-2 text-xs text-foreground">{blocked}</p>
          ) : null}
          {failureNote}
          <div className="flex flex-wrap items-center gap-1.5">
            {nothingChanged ? null : (
              <Button
                type="button"
                size="xs"
                disabled={!idle || nothingTicked || !!blocked}
                title={blocked ?? undefined}
                onClick={() =>
                  void run(
                    () =>
                      actions.acceptSuggestion(
                        suggestion,
                        partial ? [...selected].sort((a, b) => a - b) : undefined,
                      ),
                    true,
                  )
                }
              >
                {partial ? `Accept ${selected.size} of ${total}` : 'Accept'}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!idle}
              onClick={() => void run(() => actions.rejectSuggestion(suggestion), true)}
            >
              Reject
            </Button>
            {tryAgain}
          </div>
          {partial && linked ? (
            <p className="text-[11px] text-muted-foreground">
              Accepting only some changes leaves the linked comments and issues open.
            </p>
          ) : null}
        </>
      ) : null}

      {status === 'failed' || status === 'cancelled' ? (
        <>
          <p className="text-xs text-foreground">
            {status === 'cancelled'
              ? payload.cancelledBy !== null && payload.cancelledBy === ctx.currentUserId
                ? 'You stopped this revision before it finished.'
                : 'This revision was cancelled before it finished.'
              : describeSuggestionFailure(
                  payload.error?.code ?? null,
                  payload.error?.message ?? '',
                )}
          </p>
          {failureNote}
          <div className="flex items-center gap-1.5">
            {tryAgain}
            {canDismiss ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!idle}
                onClick={() => void run(() => actions.dismissSuggestion(suggestion), true)}
              >
                Dismiss
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      {status === 'accepted' || status === 'rejected' ? (
        <p className="text-xs text-muted-foreground">
          {status === 'accepted'
            ? undone
              ? 'Accepted, then undone: the text was restored.'
              : payload.appliedHunks
                ? `${payload.appliedHunks.length} of ${total} changes applied.`
                : 'The changes were applied.'
            : 'These changes were not applied.'}
          {/* The model's summary describes all of its changes, which a partial accept did not apply. */}
          {summary && !payload.appliedHunks ? ` ${summary}` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** Body slot of a standalone suggestion card. */
export function SuggestionBody({ thread, ctx }: MarginCardPartProps) {
  return <SuggestionActions suggestion={thread.root} thread={thread} ctx={ctx} />;
}

/**
 * A suggestion that arrived inside a comment thread (`@copilot`, Send to Copilot): the same status,
 * diff and actions, stacked in the thread's body instead of the card's slots.
 */
export function SuggestionBlock({ suggestion, thread, ctx }: BodyProps) {
  const payload = suggestionPayload(suggestion);
  return (
    <div
      data-suggestion-id={suggestion.id}
      className="flex flex-col gap-2 rounded-md border border-dashed p-2"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Sparkles className="size-3.5 text-muted-foreground" aria-hidden="true" />
        Copilot
        <span className="ml-auto flex items-center gap-1">
          <SuggestionStatusPill suggestion={suggestion} />
        </span>
      </div>
      {hasDiff(suggestion, payload) ? (
        <SuggestionDiffPart suggestion={suggestion} payload={payload} />
      ) : null}
      <SuggestionActions suggestion={suggestion} thread={thread} ctx={ctx} inline />
    </div>
  );
}
