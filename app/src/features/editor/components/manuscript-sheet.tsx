import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import { useTheme } from 'next-themes';
import { Copy, Download, ExternalLink, Info, Lock, MoreHorizontal, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { EditorView } from '@codemirror/view';

import { auth } from '@/api/queries/auth';
import { useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import { runs as runQueries } from '@/api/queries/runs';
import type { OutlineNode } from '@/api/types';
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
import type { Anchor } from '@/features/editor/lib/anchors';
import type { MarginCardContext } from '@/features/editor/margin/card-registry';
import { COPILOT_ACTIONS_ENABLED } from '@/features/editor/margin/flags';
import { writeGeometry, sourceGeometry } from '@/features/editor/margin/geometry';
import { useMarginHost } from '@/features/editor/margin/margin-host';
import { MarginPanel } from '@/features/editor/margin/margin-panel';
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
  /** Hook point for the header's Copilot button (issue #182 phase 4) — the button stays disabled until it is given. */
  onOpenCopilot?: () => void;
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
  onOpenCopilot,
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

  const updateMutation = useUpdateOutlineNodeMutation(projectId, node.id);
  // What this editor has sent (and so what coming back from the server is not "someone else's change").
  const sentRef = useRef(new Set<string>());
  const { status, schedule, flush, cancel } = useDebouncedMutation<string>({
    onSave: (text) => {
      sentRef.current.add(text);
      return updateMutation.mutateAsync(
        useLatex ? { contentLatex: text } : { contentMarkdown: text },
      );
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
  useEffect(() => () => flushRef.current(), []);

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
  const isDirty = isUnsavedStatus(status);
  // Non-leaf nodes (chapters/parts with children) never get LLM-generated content — only leaf
  // sections do (book_builder.py's generate_contents walks leaves only) — so the empty-state
  // copy and the Copilot's regenerate action must not offer generation for them (issue #77's
  // 409 guard covers the API side; this covers the UI so the offer isn't made in the first place).
  const nodeIsLeaf = isLeaf(node.id, flatNodes);

  // ---- server content changed under an open editor (an accepted suggestion, another user) ----------
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  /** The text the server last had that this editor agrees with: edits are "unsaved" relative to it. */
  const baselineRef = useRef(serverText);

  const adoptServerContent = useCallback(
    (text: string) => {
      const next = normalizeEol(text);
      cancel();
      baselineRef.current = next;
      sentRef.current.clear();
      setIncoming(null);
      setDraft(next);
      setResetKey((key) => key + 1);
    },
    [cancel],
  );

  useEffect(() => {
    if (serverText === baselineRef.current) return;
    const unsaved = draftRef.current !== baselineRef.current;
    const ours = sentRef.current.has(serverText) || serverText === draftRef.current;
    if (ours) {
      // Our own save coming back.
      baselineRef.current = serverText;
      return;
    }
    if (!unsaved) adoptServerContent(serverText);
    else setIncoming(serverText);
  }, [serverText, adoptServerContent]);

  // ---- margin: comments anchored to ranges of the text (issue #182, phase 2) ------------------
  const marginHost = useMarginHost();
  const { data: me } = useQuery(auth.me());
  // The server anchors against `contentMarkdown` only: a LaTeX-only section gets no range comments.
  const anchorsEnabled = !useLatex;
  const section = useSectionComments(projectId, node.id, draft, {
    mode: view === 'source' && cmView ? 'cm' : 'diff',
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
  useEffect(() => {
    resetMargin();
    return resetMargin;
  }, [resetMargin]);

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
  }, [view, cmView, section.highlights, focusedId, composeTick]);

  // The editor reports where tracked ranges went after each edit. A replace-all from outside says
  // nothing about that: the anchors are re-resolved from their quotes instead (`resetKey`).
  const { reportMapped } = section;
  const handleHighlightsMapped = useCallback(
    (ranges: Map<string, { start: number; end: number } | null>, external: boolean) => {
      if (!external) reportMapped(ranges);
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

  const cardContext = useMemo<MarginCardContext>(
    () => ({
      projectId,
      nodeId: node.id,
      currentUserId: me?.id ?? null,
      copilotActions: COPILOT_ACTIONS_ENABLED,
      restoreEditorFocus,
      // These two read refs, but only when a card calls them (never while rendering).
      // eslint-disable-next-line react-hooks/refs
      applyServerContent: adoptServerContent,
      // eslint-disable-next-line react-hooks/refs
      hasUnsavedEdits,
    }),
    [projectId, node.id, me?.id, restoreEditorFocus, adoptServerContent, hasUnsavedEdits],
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

  // Blocks in-app navigation (and warns on tab close) while there's an unsaved edit the
  // 800ms debounce hasn't flushed yet — `flush()` on blur/unmount/Ctrl-S covers the rest.
  useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: true,
    disabled: readOnly,
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
              onOpenCopilot
                ? 'Prompt the copilot about this section'
                : 'Coming soon: prompt the copilot here'
            }
            disabled={!onOpenCopilot}
            onClick={onOpenCopilot}
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
            unsaved edits are kept; saving them will overwrite that change.
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => adoptServerContent(incoming)}
          >
            Load the other version
          </Button>
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
                      ? 'This section is empty. Switch to Source to write it, or use the Copilot to generate it.'
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
          copilotActions={COPILOT_ACTIONS_ENABLED}
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
