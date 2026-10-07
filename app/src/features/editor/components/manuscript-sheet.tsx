import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import { useTheme } from 'next-themes';
import { Copy, Download, ExternalLink, Lock, MoreHorizontal, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

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
import { SourcesDrawer } from '@/features/editor/components/sources-drawer';
import { SectionEditor } from '@/features/editor/components/section-editor';
import { SectionJumpSelect } from '@/features/editor/components/section-jump-select';
import { useEffectiveSources } from '@/features/editor/hooks/use-effective-sources';
import { useDebouncedMutation } from '@/features/editor/hooks/use-debounced-mutation';
import { parseRagCitations } from '@/features/editor/lib/rag-citation';
import { isUnsavedStatus } from '@/features/editor/lib/save-status';
import { characterCount, wordCount } from '@/features/editor/lib/word-count';
import { findSectionArtifact } from '@/features/exports/lib/artifacts';
import { fileContentUrl } from '@/features/exports/lib/file-url';
import { isLeaf } from '@/features/outline/model';
import { useEditorSelectionStore } from '@/stores/editor-selection-store';
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

  const [draft, setDraft] = useState(node[field]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [optionsFocusSources, setOptionsFocusSources] = useState(false);
  const setSelection = useEditorSelectionStore((state) => state.setSelection);

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
  const { status, schedule, flush } = useDebouncedMutation<string>({
    onSave: (text) =>
      updateMutation.mutateAsync(useLatex ? { contentLatex: text } : { contentMarkdown: text }),
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

  // The caret readout belongs to the Source view; clear it when that editor goes away.
  useEffect(() => {
    if (view !== 'source') setSelection(null);
    return () => setSelection(null);
  }, [view, setSelection]);

  const closeSources = useCallback(() => setSourcesOpen(false), []);

  function handleCopy() {
    navigator.clipboard
      .writeText(draft)
      .then(() => toast.success('Markdown copied to clipboard'))
      .catch(() => toast.error('Could not copy to clipboard'));
  }

  const citations = parseRagCitations(node.ragCitations);
  const effectiveSources = useEffectiveSources(projectId, node.id, flatNodes);
  const isDirty = isUnsavedStatus(status);
  // Non-leaf nodes (chapters/parts with children) never get LLM-generated content — only leaf
  // sections do (book_builder.py's generate_contents walks leaves only) — so the empty-state
  // copy and the Copilot's regenerate action must not offer generation for them (issue #77's
  // 409 guard covers the API side; this covers the UI so the offer isn't made in the first place).
  const nodeIsLeaf = isLeaf(node.id, flatNodes);

  // Blocks in-app navigation (and warns on tab close) while there's an unsaved edit the
  // 800ms debounce hasn't flushed yet — `flush()` on blur/unmount/Ctrl-S covers the rest.
  useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: true,
    disabled: readOnly,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneToolbar>
        <div className="flex min-w-0 items-center gap-2">
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

      <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
        {view === 'source' ? (
          <SectionEditor
            value={draft}
            onChange={handleChange}
            onFlush={flush}
            readOnly={readOnly}
            language={useLatex ? 'latex' : 'markdown'}
            theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
            onSelectionChange={setSelection}
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
                <LazyMarkdownView markdown={draft} citations={citations} />
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

      {sourcesOpen ? (
        <SourcesDrawer
          id={SOURCES_DRAWER_ID}
          sources={effectiveSources.sources}
          failedSources={effectiveSources.failedSources}
          loading={effectiveSources.loading}
          scope={effectiveSources.scope}
          scopeFromLabel={
            effectiveSources.scopeFrom
              ? `§${effectiveSources.scopeFrom.sectionNumber} ${effectiveSources.scopeFrom.title}`
              : null
          }
          citations={citations}
          onChangeScope={() => {
            setSourcesOpen(false);
            setOptionsFocusSources(true);
            setOptionsOpen(true);
          }}
          onClose={closeSources}
        />
      ) : null}

      <EditorStatusBar
        characters={characterCount(draft)}
        words={wordCount(draft)}
        sourceCount={effectiveSources.loading ? null : effectiveSources.sources.length}
        sourcesOpen={sourcesOpen}
        sourcesDrawerId={SOURCES_DRAWER_ID}
        onToggleSources={() => setSourcesOpen((open) => !open)}
        onCloseSources={closeSources}
        showCaret={view === 'source'}
      />
    </div>
  );
}
