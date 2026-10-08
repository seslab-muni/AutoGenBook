import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import { useTheme } from 'next-themes';
import { Copy, Download, ExternalLink, Info, Lock, MoreHorizontal, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { EditorView } from '@codemirror/view';

import { auth } from '@/api/queries/auth';
import { ApiError } from '@/api/client';
import { outline as outlineQueries, useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import { runs as runQueries } from '@/api/queries/runs';
import type { OutlineNode, OutlineNodeUpdate } from '@/api/types';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ChapterOptionsPopover } from '@/features/editor/components/chapter-options-popover';
import { EditorStatusBar } from '@/features/editor/components/editor-status-bar';
import { HeaderIconButton } from '@/features/editor/components/header-icon-button';
import { LockContentButton } from '@/features/editor/components/lock-content-button';
import { SaveStatusBadge } from '@/features/editor/components/save-status-badge';
import { LazyMarkdownView } from '@/features/editor/components/markdown-view-lazy';
import { SourcesDrawer, type SourcesDrawerView } from '@/features/editor/components/sources-drawer';
import { SectionEditor } from '@/features/editor/components/section-editor';
import { SectionJumpSelect } from '@/features/editor/components/section-jump-select';
import { useEffectiveSources } from '@/features/editor/hooks/use-effective-sources';
import { useDebouncedMutation } from '@/features/editor/hooks/use-debounced-mutation';
import { useSectionComments } from '@/features/editor/hooks/use-section-comments';
import {
  anchorFocusedOf,
  anchorHighlightsMatch,
  setAnchorHighlights,
  setFocusedAnchor,
} from '@/features/editor/lib/cm-anchor-highlights';
import { normalizeEol } from '@/features/editor/lib/eol';
import { sha256Hex } from '@/lib/content-hash';
import { problemMessage } from '@/features/editor/margin/errors';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { Anchor } from '@/features/editor/lib/anchors';
import type { MarginCardContext } from '@/features/editor/margin/card-registry';
import { writeGeometry, sourceGeometry } from '@/features/editor/margin/geometry';
import { useMarginHost } from '@/features/editor/margin/margin-host';
import type { RewriteBlock } from '@/features/editor/margin/card-registry';
import { toServerAnchor } from '@/features/editor/lib/server-anchor';
import { useProjectRuns } from '@/features/runs/hooks/use-project-runs';
import { MarginPanel } from '@/features/editor/margin/margin-panel';
import { useCopilot } from '@/features/editor/margin/use-copilot';
import { useSuggestionStreams } from '@/features/editor/margin/suggestion-progress';
import { parseReviewSummary } from '@/features/editor/lib/card-payloads';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { SelectionLayer } from '@/features/editor/margin/selection-layer';
import { parseRagCitations } from '@/features/editor/lib/rag-citation';
import { isUnsavedStatus } from '@/features/editor/lib/save-status';
import { characterCount, wordCount } from '@/features/editor/lib/word-count';
import { findSectionArtifact } from '@/features/exports/lib/artifacts';
import { fileContentUrl } from '@/features/exports/lib/file-url';
import { isLeaf } from '@/features/outline/model';
import { useEditorSelectionStore } from '@/stores/editor-selection-store';
import { useRightColumn } from '@/components/layout/use-right-pane';
import { useEditorStore, useEditorView } from '@/stores/editor-store';

const SOURCES_DRAWER_ID = 'editor-sources-drawer';

interface ManuscriptSheetProps {
  projectId: string;
  node: OutlineNode;
  projectTitle: string;
  lastRunId?: string | null;
  flatNodes: readonly OutlineNode[];
  outlineOpen: boolean;
  onSelectNode: (nodeId: string) => void;
  /** Open with the prompt window on Rewrite, with this instruction ("Regenerate again" on a run page). */
  initialRewrite?: { instruction: string } | null;
  onInitialRewriteConsumed?: () => void;
}

/**
 * The centre pane's main content once a section is selected: a toolbar
 * (content lock, Write/Source toggle, Chapter options, Copilot, section jump select, copy,
 * "open in run", save status), the manuscript "sheet" (Write) or the raw `SectionEditor`
 * (Source), and the status bar.
 * Owns the debounced-autosave wiring (`useDebouncedMutation` over
 * `useUpdateOutlineNodeMutation`) so both the write and source views edit
 * the same in-memory draft.
 */
export function ManuscriptSheet({
  projectId,
  node,
  projectTitle,
  lastRunId,
  flatNodes,
  outlineOpen,
  onSelectNode,
  initialRewrite = null,
  onInitialRewriteConsumed,
}: ManuscriptSheetProps) {
  const view = useEditorView();
  const setView = useEditorStore((state) => state.setView);
  const { resolvedTheme } = useTheme();

  const useLatex = node.contentLatex.length > 0 && node.contentMarkdown.length === 0;
  const field = useLatex ? 'contentLatex' : 'contentMarkdown';
  const readOnly = node.status === 'drafting';

  // Counted over LF text everywhere (CodeMirror normalises line endings, so anchors must too).
  const serverText = normalizeEol(node[field]);
  const [draft, setDraft] = useState(serverText);
  /** Bumped when the draft is replaced from outside (server content): anchors are re-resolved from their quotes. */
  const [resetKey, setResetKey] = useState(0);
  /** Another change to this section arrived while there were unsaved edits (shown, never applied silently). */
  const [incoming, setIncoming] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [drawerView, setDrawerView] = useState<SourcesDrawerView>('sources');
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  const [optionsFocusSources, setOptionsFocusSources] = useState(false);
  const setSelection = useEditorSelectionStore((state) => state.setSelection);
  const [composeTick, setComposeTick] = useState(0);
  /** Bumped after an outside replace-all so the highlights are pushed again onto the new text. */
  const [pushTick, setPushTick] = useState(0);
  // The text pane's scroll container (Write) and the CodeMirror view (Source): what the margin
  // measures anchors against.
  const [region, setRegion] = useState<HTMLElement | null>(null);
  const [cmView, setCmView] = useState<EditorView | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // The outline's flat cache is what mutations patch optimistically, so the lock button and
  // Chapter options read their node from it (falling back to the fetched copy) to stay live.
  const liveNode = flatNodes.find((item) => item.id === node.id) ?? node;

  // The `sections/<cliKey>.md` artifact the last full run produced for this node, if any — lets
  // the toolbar offer a direct "Download section .md" link (issue #22) alongside "Copy Markdown".
  const { data: lastRunArtifacts } = useQuery({
    ...runQueries.artifacts(lastRunId ?? ''),
    enabled: !!lastRunId,
  });
  const sectionArtifact = findSectionArtifact(lastRunArtifacts?.items, node.cliKey);

  const updateMutation = useUpdateOutlineNodeMutation(projectId, node.id, { handlesErrors: true });
  /** Why the last save failed, when it was not a conflict (the badge says "Error saving", this says why). */
  const [saveError, setSaveError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // What this editor has sent (and so what coming back from the server is not "someone else's change").
  const sentRef = useRef(new Set<string>());
  // The text the draft is based on, as the SERVER holds it: raw (line endings included), its
  // `contentHash`, and the LF-normalised copy edits are compared against. Moved only when the
  // baseline itself moves - an adoption, this editor's own successful save, "Keep mine" - never
  // by whatever the query cache happens to hold when a save runs: a save made on top of text the
  // user has not seen (an accept that landed meanwhile) must be refused as a conflict, not pass
  // with the newer text's hash and overwrite it.
  const baselineRef = useRef(normalizeEol(node[field]));
  const baseRawRef = useRef(node[field]);
  const baseHashRef = useRef<string | null>(useLatex ? null : (node.contentHash ?? null));
  /** Hashes of baselines this editor has moved past, and the newest `updatedAt` it has seen. */
  const supersededRef = useRef(new Set<string>());
  const knownUpdatedAtRef = useRef(node.updatedAt);
  const moveBaseline = useCallback(
    (raw: string, hash: string | null | undefined, updatedAt?: string) => {
      const previous = baseHashRef.current;
      if (previous && previous !== hash) supersededRef.current.add(previous);
      baselineRef.current = normalizeEol(raw);
      baseRawRef.current = raw;
      baseHashRef.current = hash ?? null;
      if (updatedAt && updatedAt > knownUpdatedAtRef.current) knownUpdatedAtRef.current = updatedAt;
    },
    [],
  );

  const { status, schedule, flush, cancel, hold, flushEdits, whenIdle } =
    useDebouncedMutation<string>({
      onSave: async (text) => {
        // Bounded: only the last few saves matter for recognising our own content coming back.
        sentRef.current.add(text);
        if (sentRef.current.size > 8)
          sentRef.current.delete(sentRef.current.values().next().value!);
        const body: OutlineNodeUpdate = useLatex
          ? { contentLatex: text }
          : { contentMarkdown: text };
        if (!useLatex) {
          // Without the hash of the text this draft was based on the server would take the write as
          // last-write-wins and overwrite an accepted suggestion or another editor's save.
          const expectedContentHash =
            baseHashRef.current ?? (await sha256Hex(baseRawRef.current)) ?? undefined;
          if (expectedContentHash) body.expectedContentHash = expectedContentHash;
        }
        try {
          const saved = await updateMutation.mutateAsync(body);
          // What this save wrote is the new baseline, with the hash the server gave it.
          moveBaseline(
            text,
            useLatex ? null : (saved.contentHash ?? (await sha256Hex(text))),
            saved.updatedAt,
          );
          setSaveError(null);
          return saved;
        } catch (error) {
          if (error instanceof ApiError && error.problem?.code === 'content_conflict') {
            // The section changed under this draft: fetch the other version. The effect below turns
            // it into the "changed elsewhere" notice (Keep mine / Load the other version) - the save
            // is never retried over it.
            sentRef.current.delete(text);
            setSaveError(null);
            // Cancelled by a save or an accept that starts meanwhile: nothing to report.
            queryClient
              .fetchQuery({ ...outlineQueries.node(projectId, node.id), staleTime: 0 })
              .catch(() => undefined);
          } else {
            setSaveError(problemMessage(error));
          }
          throw error;
        }
      },
    });

  // `EditorPane` mounts this component with `key={node.id}`, so a different
  // node selection remounts it fresh (new `useState` initial value) rather
  // than needing an effect to reset `draft` — see React's "resetting state
  // when a prop changes" guidance.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  /** Set when the person chose to leave and discard: nothing is saved on the way out. */
  const discardRef = useRef(false);
  useEffect(
    () => () => {
      // Leaving saves what is pending - unless it was discarded on purpose, or the server's text moved
      // under it (the save would only be refused again).
      if (!discardRef.current && incomingRef.current === null) flushRef.current();
    },
    [],
  );

  // Stable identities (here, `closeSources` and the store's `setSelection`) keep `SectionEditor`'s
  // CodeMirror extensions from being reconfigured on every keystroke or caret move.
  const handleChange = useCallback(
    (value: string) => {
      if (readOnly) return;
      setDraft(value);
      schedule(value);
    },
    [readOnly, schedule],
  );

  // The selection (caret readout, selection toolbar) belongs to whichever view is showing;
  // clear it when that view goes away.
  useEffect(() => {
    return () => {
      setSelection(null);
      setCmView(null);
    };
  }, [view, setSelection]);

  const closeSources = useCallback(() => setSourcesOpen(false), []);
  // A citation chip opens the sources drawer on its Citations list (where the old right-pane tab went).
  const handleCitationClick = useCallback(() => {
    setDrawerView('citations');
    setSourcesOpen(true);
  }, []);

  function handleCopy() {
    navigator.clipboard
      .writeText(draft)
      .then(() => toast.success('Markdown copied to clipboard'))
      .catch(() => toast.error('Could not copy to clipboard'));
  }

  const citations = useMemo(() => parseRagCitations(node.ragCitations), [node.ragCitations]);
  const effectiveSources = useEffectiveSources(projectId, node.id, flatNodes);
  // Non-leaf nodes (chapters/parts with children) never get LLM-generated content — only leaf
  // sections do (book_builder.py's generate_contents walks leaves only) — so the empty-state
  // copy and the copilot must not offer generation for them (issue #77's 409 guard covers the API
  // side; this covers the UI so the offer isn't made in the first place).
  const nodeIsLeaf = isLeaf(node.id, flatNodes);

  // ---- server content changed under an open editor (an accepted suggestion, another user) ----------
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const nodeRef = useRef(node);
  useEffect(() => {
    nodeRef.current = node;
  }, [node]);
  /** The other version waiting for the user's choice, raw, with its hash (null until known). */
  const incomingRef = useRef<{ raw: string; hash: string | null } | null>(null);

  const adoptServerContent = useCallback(
    (raw: string, hash?: string | null, updatedAt?: string) => {
      const next = normalizeEol(raw);
      cancel();
      moveBaseline(raw, hash, updatedAt);
      sentRef.current.clear();
      incomingRef.current = null;
      setIncoming(null);
      setDraft(next);
      setResetKey((key) => key + 1);
    },
    [cancel, moveBaseline],
  );

  /** Shows the "changed elsewhere" notice and holds autosave, at once (not after the next render). */
  const showIncoming = useCallback(
    (raw: string, hash: string | null | undefined) => {
      incomingRef.current = { raw, hash: hash ?? null };
      setIncoming(normalizeEol(raw));
      hold(true);
    },
    [hold],
  );

  useEffect(() => {
    const current = nodeRef.current;
    if (serverText === baselineRef.current) return;
    // A fetch that began before this editor's own save or adoption can answer with the text from
    // before it: never take a version older than what was last adopted or saved as "the server's".
    if (
      current.contentHash &&
      supersededRef.current.has(current.contentHash) &&
      current.updatedAt <= knownUpdatedAtRef.current
    ) {
      return;
    }
    const unsaved = draftRef.current !== baselineRef.current;
    const ours = sentRef.current.has(serverText) || serverText === draftRef.current;
    if (ours) {
      // Our own save coming back (or the other side reverted to what we have).
      moveBaseline(current[field], current.contentHash, current.updatedAt);
      incomingRef.current = null;
      setIncoming(null);
      // The server holds exactly the draft (a refused save whose other version turned out equal):
      // nothing is left to save, and a failed-save state would be stale.
      if (serverText === draftRef.current) cancel();
      return;
    }
    if (!unsaved) adoptServerContent(current[field], current.contentHash, current.updatedAt);
    else showIncoming(current[field], current.contentHash);
  }, [serverText, field, adoptServerContent, showIncoming, moveBaseline, cancel]);

  // A conflicting change from elsewhere is pending: nothing may be saved until the user has chosen.
  useEffect(() => {
    hold(incoming !== null);
    return () => hold(false);
  }, [incoming, hold]);

  /** "Keep mine": the other version is deliberately overwritten by the draft, based on its hash. */
  const keepMine = useCallback(async () => {
    // Behind this editor's own save, if one is still in flight: its outcome can change what the other
    // version is (or whether there is one), and moving the baseline under it would make them race.
    await whenIdle();
    const other = incomingRef.current;
    if (!other) return;
    moveBaseline(other.raw, other.hash);
    incomingRef.current = null;
    setIncoming(null);
    hold(false);
    schedule(draftRef.current);
    flush();
  }, [hold, schedule, flush, moveBaseline, whenIdle]);

  // ---- margin: comments anchored to ranges of the text (issue #182, phase 2) ------------------
  const marginHost = useMarginHost();
  const { data: me } = useQuery(auth.me());
  // The server anchors against `contentMarkdown` only: a LaTeX-only section gets no range comments.
  const anchorsEnabled = !useLatex;
  const section = useSectionComments(projectId, node.id, draft, {
    resetKey,
    anchorsEnabled,
  });
  const focusedId = useMarginStore((state) => state.focusedId);
  const focusThread = useMarginStore((state) => state.focus);
  const focusCard = useMarginStore((state) => state.focusCard);
  const openComposer = useMarginStore((state) => state.openComposer);
  const resetMargin = useMarginStore((state) => state.reset);
  const { revealMargin } = useRightColumn();

  // Margin state is per open section (the sheet is keyed by node id).
  const restoreComposer = useMarginStore((state) => state.restoreComposer);
  useEffect(() => {
    resetMargin();
    // The composer this section was left with (an unsent prompt or comment) comes back with it.
    restoreComposer(node.id);
    return () => resetMargin(node.id);
  }, [resetMargin, restoreComposer, node.id]);

  const reviewSummary = useMemo(
    () => parseReviewSummary(liveNode.reviewSummary),
    [liveNode.reviewSummary],
  );

  // A section reviewed before review rows existed has only the old flattened notes: no summary and no cards.
  const legacyNotes =
    !reviewSummary &&
    liveNode.reviewerNotes?.trim() &&
    !section.threads.some((thread) => thread.kind === 'review')
      ? liveNode.reviewerNotes
      : null;

  const geometry = useMemo(() => {
    if (view === 'source') return cmView ? sourceGeometry(cmView) : null;
    return region ? writeGeometry(region) : null;
  }, [view, cmView, region]);

  // Source: the decoration field tracks every range through the editor's own change sets. Pushed to
  // only when the resolved set really differs from what it already holds (never per keystroke), and
  // never in the middle of an IME composition.
  useEffect(() => {
    if (view !== 'source' || !cmView) return undefined;
    const onCompositionEnd = () => setComposeTick((tick) => tick + 1);
    cmView.dom.addEventListener('compositionend', onCompositionEnd);
    if (!cmView.composing) {
      const effects = [];
      if (!anchorHighlightsMatch(cmView.state, section.highlights)) {
        effects.push(setAnchorHighlights.of(section.highlights));
      }
      if (anchorFocusedOf(cmView.state) !== focusedId) effects.push(setFocusedAnchor.of(focusedId));
      if (effects.length > 0) cmView.dispatch({ effects });
    }
    return () => cmView.dom.removeEventListener('compositionend', onCompositionEnd);
  }, [view, cmView, section.highlights, focusedId, composeTick, pushTick]);

  // The editor reports where tracked ranges went after each edit. A replace-all from outside says
  // nothing about that: the anchors are re-resolved from their quotes instead (`resetKey`).
  const { reportMapped } = section;
  const handleHighlightsMapped = useCallback(
    (ranges: Map<string, { start: number; end: number } | null>, external: boolean) => {
      if (!external) reportMapped(ranges);
      // The replace collapsed every tracked range: push the freshly resolved ones once it has landed.
      else setPushTick((tick) => tick + 1);
    },
    [reportMapped],
  );

  // Write: highlights are painted over the rendered text without touching it (or the selection).
  const writeMarks = useMemo(
    () => section.highlights.filter((highlight) => !highlight.hidden),
    [section.highlights],
  );

  const handleHighlightClick = useCallback(
    (ids: string[]) => {
      const id = ids[0];
      if (!id) return;
      focusThread(id);
      revealMargin();
    },
    [focusThread, revealMargin],
  );

  const restoreEditorFocus = useCallback(() => {
    if (view === 'source') cmView?.focus();
    else region?.focus();
  }, [view, cmView, region]);

  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const hasUnsavedEdits = useCallback(
    () => draftRef.current !== baselineRef.current || isUnsavedStatus(statusRef.current),
    [],
  );

  /**
   * The server now holds `raw` (an accepted suggestion, its undo). Adopted at once when the editor
   * has nothing unsaved; otherwise the draft stays exactly as typed and the "changed elsewhere"
   * notice offers the choice - set before the caller releases its hold, so nothing can save over it.
   */
  const applyServerContent = useCallback(
    (raw: string, hash?: string | null) => {
      if (hasUnsavedEdits()) showIncoming(raw, hash);
      else adoptServerContent(raw, hash);
    },
    [hasUnsavedEdits, showIncoming, adoptServerContent],
  );

  // Holds autosave for a write the server makes to the section (an accept, its undo): the pending
  // edits are saved first, then nothing is saved until the returned function releases the hold.
  const holdCounter = useRef(0);
  const holdSaving = useCallback(async () => {
    await flushEdits();
    holdCounter.current += 1;
    const reason = `copilot:${holdCounter.current}`;
    hold(true, reason);
    return () => {
      hold(false, reason);
      // Edits typed meanwhile are saved now - unless the server's text moved under them, in which
      // case the notice owns them and saving waits for the user's choice.
      if (incomingRef.current === null) flush();
    };
  }, [flushEdits, hold, flush]);

  const getDraft = useCallback(() => draftRef.current, []);
  // The server stores the text as it was written: with CR LF endings the editor's (LF) offsets would
  // point at the wrong place, so they are left out and the server finds the quote itself.
  const serverAnchor = useCallback(
    (anchor: Parameters<typeof toServerAnchor>[0]) =>
      toServerAnchor(anchor, { crlf: baseRawRef.current.includes('\r') }),
    [],
  );
  const copilot = useCopilot({
    projectId,
    nodeId: node.id,
    getText: getDraft,
    flushEdits,
    enabled: anchorsEnabled,
    serverAnchor,
  });
  useSuggestionStreams(projectId, node.id, section.threads);

  // "Regenerate again" on a run page lands here: the window opens on Rewrite, once.
  const rewriteOpened = useRef(false);
  useEffect(() => {
    if (!initialRewrite || rewriteOpened.current) return;
    rewriteOpened.current = true;
    copilot.openPrompt(null, 'header', {
      verb: 'rewrite',
      text: initialRewrite.instruction,
      explicit: true,
    });
    onInitialRewriteConsumed?.();
  }, [initialRewrite, copilot, onInitialRewriteConsumed]);

  // Why a whole-section Rewrite (a regenerate run) cannot start, found out before anything is sent.
  const { runningRun, queuedRuns } = useProjectRuns(projectId);
  const queuedHere = queuedRuns.some(
    (run) => run.kind === 'regenerate_section' && run.targetNodeId === node.id,
  );
  const rewriteBlock = useMemo<RewriteBlock | null>(() => {
    if (!nodeIsLeaf) {
      return {
        reason:
          'This is a container node — only leaf sections can be rewritten. Select a leaf section below it.',
        remedy: null,
      };
    }
    if (liveNode.contentLocked) {
      return {
        reason: 'This section’s content is locked — unlock it to rewrite it.',
        remedy: 'unlock',
      };
    }
    if (!node.cliKey) {
      return {
        reason: 'This section has no CLI key yet — it appears after the next full run.',
        remedy: 'start-run',
      };
    }
    if (!lastRunId) {
      return {
        reason: 'No successful prior run to resume from — start a full run first.',
        remedy: 'start-run',
      };
    }
    if (queuedHere) return { reason: 'This section already has a rewrite queued.', remedy: null };
    if (runningRun) return { reason: 'A run is currently running for this project.', remedy: null };
    return null;
  }, [nodeIsLeaf, liveNode.contentLocked, node.cliKey, lastRunId, queuedHere, runningRun]);

  const threadsRef = useRef(section.threads);
  useEffect(() => {
    threadsRef.current = section.threads;
  }, [section.threads]);
  const knownIds = useCallback(
    () =>
      new Set(
        threadsRef.current.flatMap((thread) => [
          thread.root.id,
          ...thread.replies.map((r) => r.id),
        ]),
      ),
    [],
  );

  const editBlockedReason =
    incoming !== null
      ? 'This section was changed elsewhere. Choose Keep mine or Load the other version first.'
      : null;

  const cardContext = useMemo<MarginCardContext>(
    () => ({
      projectId,
      nodeId: node.id,
      currentUserId: me?.id ?? null,
      restoreEditorFocus,
      // These read refs, but only when a card calls them (never while rendering).
      applyServerContent,
      hasUnsavedEdits,
      flushEdits,
      holdSaving,
      sectionNumber: node.sectionNumber,
      serverAnchor,
      editBlockedReason,
      revisable: anchorsEnabled,
      rewriteBlock,
      knownIds,
      startRevision: copilot.startRevision,
      onSendToCopilot: anchorsEnabled ? copilot.sendToCopilot : undefined,
      onFixWithCopilot: anchorsEnabled ? copilot.fixWithCopilot : undefined,
      onTryAgain: copilot.tryAgain,
      onCommentSent: anchorsEnabled ? copilot.commentSent : undefined,
    }),
    [
      projectId,
      node.id,
      node.sectionNumber,
      me?.id,
      restoreEditorFocus,
      applyServerContent,
      hasUnsavedEdits,
      flushEdits,
      holdSaving,
      serverAnchor,
      editBlockedReason,
      anchorsEnabled,
      rewriteBlock,
      knownIds,
      copilot,
    ],
  );

  const startComment = useCallback(
    (anchor: Anchor) => {
      openComposer({ kind: 'comment', anchor });
      revealMargin();
    },
    [openComposer, revealMargin],
  );
  const focusThreadCard = useCallback(
    (id: string) => {
      revealMargin();
      focusCard(id);
    },
    [revealMargin, focusCard],
  );

  // Leaving with work the server does not have - typed and not yet saved, a save that failed, an
  // incoming version the person has not chosen about - asks first, for every way out of the section
  // (an outline row, Add chapter, a route change) and for closing the tab. "Leave and discard" saves
  // nothing on the way out.
  const unsavedWork = useCallback(
    () =>
      draftRef.current !== baselineRef.current ||
      incomingRef.current !== null ||
      statusRef.current === 'error' ||
      isUnsavedStatus(statusRef.current),
    [],
  );
  const blocker = useBlocker({
    shouldBlockFn: unsavedWork,
    enableBeforeUnload: unsavedWork,
    disabled: readOnly,
    withResolver: true,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneToolbar className="@container">
        <div className="-mx-0.5 -my-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-0.5 py-1">
          <LockContentButton projectId={projectId} node={liveNode} flat={flatNodes} />
          <ToggleGroup
            aria-label="Editor view"
            value={view}
            onValueChange={(value) => setView(value as 'write' | 'source')}
          >
            <ToggleGroupItem value="write">Write</ToggleGroupItem>
            <ToggleGroupItem value="source">Source</ToggleGroupItem>
          </ToggleGroup>
          <ChapterOptionsPopover
            projectId={projectId}
            node={liveNode}
            flat={flatNodes}
            open={optionsOpen}
            focusSources={optionsFocusSources}
            onOpenChange={(open) => {
              setOptionsOpen(open);
              if (!open) setOptionsFocusSources(false);
            }}
          />
          <HeaderIconButton
            label="Copilot"
            tooltip={
              !nodeIsLeaf
                ? 'The copilot works on the text of a section; select a leaf section'
                : !anchorsEnabled
                  ? 'This section holds LaTeX: the copilot can only rewrite it from its brief'
                  : 'Prompt the copilot about this section'
            }
            disabled={!nodeIsLeaf}
            copilotTrigger
            onClick={() =>
              copilot.openPrompt(null, 'header', { verb: anchorsEnabled ? 'revise' : 'rewrite' })
            }
          >
            <Sparkles />
          </HeaderIconButton>
          {!outlineOpen ? (
            <SectionJumpSelect
              flat={flatNodes}
              selectedNodeId={node.id}
              onSelectNode={onSelectNode}
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon-sm" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleCopy}>
                <Copy />
                Copy Markdown
              </DropdownMenuItem>
              {sectionArtifact ? (
                <DropdownMenuItem asChild>
                  <a
                    href={fileContentUrl(sectionArtifact.fileId)}
                    download={sectionArtifact.filename}
                  >
                    <Download />
                    Download section .md
                  </a>
                </DropdownMenuItem>
              ) : null}
              {lastRunId ? (
                <DropdownMenuItem asChild>
                  <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: lastRunId }}>
                    <ExternalLink />
                    Open in run
                  </Link>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <SaveStatusBadge status={status} collapsible />
        </div>
      </PaneToolbar>

      {readOnly ? (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-2 text-xs font-medium text-warning-foreground">
          <Lock className="size-3.5 shrink-0" />
          This section is being generated by a run — editing is disabled until it finishes.
        </div>
      ) : null}
      {incoming !== null ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b bg-info/10 px-3 py-2 text-xs"
        >
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            This section was changed elsewhere (another editor, or an accepted suggestion). Your
            unsaved edits are kept and nothing is saved until you choose.
          </span>
          <Button type="button" size="xs" variant="outline" onClick={() => void keepMine()}>
            Keep mine
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              adoptServerContent(incomingRef.current?.raw ?? incoming, incomingRef.current?.hash)
            }
          >
            Load the other version
          </Button>
        </div>
      ) : null}
      {saveError !== null && incoming === null ? (
        <div role="alert" className="border-b bg-destructive/10 px-3 py-2 text-xs text-foreground">
          Your latest edits could not be saved: {saveError} They are kept here; they are saved again
          on your next edit or with Ctrl+S.
        </div>
      ) : null}
      <div ref={paneRef} className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={setRegion}
          className="custom-scrollbar min-h-0 flex-1 overflow-auto"
          // Scrollable region: focusable so keyboard users can scroll the manuscript.
          tabIndex={0}
          role="region"
          aria-label="Manuscript"
        >
          {view === 'source' ? (
            <SectionEditor
              value={draft}
              onChange={handleChange}
              onFlush={flush}
              readOnly={readOnly}
              language={useLatex ? 'latex' : 'markdown'}
              theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
              onSelectionChange={setSelection}
              onCreateEditor={setCmView}
              onHighlightClick={handleHighlightClick}
              onHighlightsMapped={handleHighlightsMapped}
              className="h-full"
            />
          ) : (
            <div className="p-2 md:p-4">
              <div className="mx-auto max-w-3xl rounded-xl border bg-card p-8 font-serif shadow-xs md:p-14">
                <div className="mb-8 border-b pb-6 text-center">
                  <div className="mb-1 font-sans text-[11px] font-bold tracking-widest text-muted-foreground uppercase">
                    {projectTitle}
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
                    {node.title}
                  </h1>
                  <div className="mt-2 font-sans text-xs font-medium text-muted-foreground">
                    Section {node.sectionNumber}
                  </div>
                </div>

                {draft.trim().length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground italic">
                    {nodeIsLeaf
                      ? 'This section is empty. Switch to Source to write it, or start a run to draft it.'
                      : 'This is a container node — it only has the outline summary shown in the assembled document. Content is generated per leaf section; select a leaf section below it to write or generate text.'}
                  </p>
                ) : (
                  <LazyMarkdownView
                    markdown={draft}
                    citations={citations}
                    anchorMarks={writeMarks}
                    focusedAnchorId={focusedId}
                    sourceMap
                    onCitationClick={handleCitationClick}
                    onAnchorClick={handleHighlightClick}
                  />
                )}

                <div className="mt-16 flex items-center justify-between border-t pt-6 font-sans text-xs text-muted-foreground">
                  <span>Page ~{Math.max(1, Math.round(wordCount(draft) / 320))}</span>
                  <span>{node.title}</span>
                  <span>§{node.sectionNumber}</span>
                </div>
              </div>
            </div>
          )}
        </div>
        <SelectionLayer
          view={view}
          text={draft}
          region={region}
          cmView={cmView}
          geometry={geometry}
          paneRef={paneRef}
          enabled={anchorsEnabled}
          highlights={section.highlights}
          onComment={startComment}
          onFocusThread={focusThreadCard}
          onPrompt={
            anchorsEnabled ? (anchor) => copilot.openPrompt(anchor, 'selection') : undefined
          }
          onChip={anchorsEnabled ? copilot.runChip : undefined}
        />
      </div>

      {marginHost
        ? createPortal(
            <MarginPanel
              ctx={cardContext}
              threads={section.threads}
              visible={section.visible}
              loading={section.loading}
              error={section.error}
              onRetry={section.retry}
              composer={section.composer}
              composerRange={section.composerRange}
              composerQuote={section.composerQuote}
              geometry={geometry}
              reviewSummary={reviewSummary}
              reviewerScore={liveNode.reviewerScore ?? null}
              legacyNotes={legacyNotes}
              anchorNote={
                anchorsEnabled
                  ? undefined
                  : 'Comments on selected text are available for Markdown sections. This section holds LaTeX, so only whole-section comments can be added.'
              }
            />,
            marginHost,
          )
        : null}

      {sourcesOpen ? (
        <SourcesDrawer
          id={SOURCES_DRAWER_ID}
          sources={effectiveSources.sources}
          failedSources={effectiveSources.failedSources}
          loading={effectiveSources.loading}
          error={effectiveSources.error}
          onRetry={effectiveSources.retry}
          scope={effectiveSources.scope}
          scopeFromLabel={
            effectiveSources.scopeFrom
              ? `§${effectiveSources.scopeFrom.sectionNumber} ${effectiveSources.scopeFrom.title}`
              : null
          }
          citations={citations}
          view={drawerView}
          onViewChange={setDrawerView}
          onChangeScope={() => {
            setSourcesOpen(false);
            setOptionsFocusSources(true);
            setOptionsOpen(true);
          }}
          onClose={() => {
            closeSources();
            sourcesButtonRef.current?.focus();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
        tone="warning"
        title="You have edits that are not saved"
        description="Stay to keep them here (they can still be saved), or leave and discard them."
        confirmLabel="Leave and discard"
        cancelLabel="Stay"
        onConfirm={() => {
          discardRef.current = true;
          cancel();
          blocker.proceed?.();
        }}
      />

      <EditorStatusBar
        characters={characterCount(draft)}
        words={wordCount(draft)}
        sourceCount={effectiveSources.loading ? null : effectiveSources.sources.length}
        sourcesError={effectiveSources.error}
        sourcesButtonRef={sourcesButtonRef}
        sourcesOpen={sourcesOpen}
        sourcesDrawerId={SOURCES_DRAWER_ID}
        onToggleSources={() => {
          if (!sourcesOpen) setDrawerView('sources');
          setSourcesOpen((open) => !open);
        }}
        onCloseSources={closeSources}
        showCaret
      />
    </div>
  );
}
