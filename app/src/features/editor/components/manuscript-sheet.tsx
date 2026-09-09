import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import { useTheme } from 'next-themes';
import { Check, Copy, Download, Lock } from 'lucide-react';
import { toast } from 'sonner';

import { useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import { runs as runQueries } from '@/api/queries/runs';
import type { OutlineNode } from '@/api/types';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EditorStatusBar } from '@/features/editor/components/editor-status-bar';
import { LazyMarkdownView } from '@/features/editor/components/markdown-view-lazy';
import { SectionEditor } from '@/features/editor/components/section-editor';
import { SectionJumpSelect } from '@/features/editor/components/section-jump-select';
import { useDebouncedMutation } from '@/features/editor/hooks/use-debounced-mutation';
import { countDisplayEquations } from '@/features/editor/lib/count-equations';
import { parseRagCitations } from '@/features/editor/lib/rag-citation';
import { isUnsavedStatus } from '@/features/editor/lib/save-status';
import { wordCount } from '@/features/editor/lib/word-count';
import { findSectionArtifact } from '@/features/exports/lib/artifacts';
import { fileContentUrl } from '@/features/exports/lib/file-url';
import { useEditorStore, useEditorView } from '@/stores/editor-store';

interface ManuscriptSheetProps {
  projectId: string;
  node: OutlineNode;
  projectTitle: string;
  lastRunId?: string | null;
  flatNodes: readonly OutlineNode[];
  outlineOpen: boolean;
  onSelectNode: (nodeId: string) => void;
}

/**
 * The centre pane's main content once a section is selected: a toolbar
 * (Preview/Source toggle, section jump select, copy, "open in run"), the
 * manuscript "sheet" preview or the raw `SectionEditor`, and the status bar.
 * Owns the debounced-autosave wiring (`useDebouncedMutation` over
 * `useUpdateOutlineNodeMutation`) so both the preview and source views edit
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
}: ManuscriptSheetProps) {
  const view = useEditorView();
  const setView = useEditorStore((state) => state.setView);
  const { resolvedTheme } = useTheme();

  const useLatex = node.contentLatex.length > 0 && node.contentMarkdown.length === 0;
  const field = useLatex ? 'contentLatex' : 'contentMarkdown';
  const readOnly = node.status === 'drafting';

  const [draft, setDraft] = useState(node[field]);
  const [copied, setCopied] = useState(false);

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

  function handleChange(value: string) {
    if (readOnly) return;
    setDraft(value);
    schedule(value);
  }

  function handleCopy() {
    navigator.clipboard
      .writeText(draft)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('Could not copy to clipboard'));
  }

  const equationCount = countDisplayEquations(draft);
  const isDirty = isUnsavedStatus(status);

  // Blocks in-app navigation (and warns on tab close) while there's an unsaved edit the
  // 800ms debounce hasn't flushed yet — `flush()` on blur/unmount/Ctrl-S covers the rest.
  useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: true,
    disabled: readOnly,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneToolbar className="gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Tabs value={view} onValueChange={(value) => setView(value as 'preview' | 'source')}>
            <TabsList>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
            </TabsList>
          </Tabs>
          {!outlineOpen ? (
            <SectionJumpSelect
              flat={flatNodes}
              selectedNodeId={node.id}
              onSelectNode={onSelectNode}
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
            {copied ? <Check className="text-success" /> : <Copy />}
            Copy Markdown
          </Button>
          {sectionArtifact ? (
            <Button type="button" variant="outline" size="sm" asChild>
              <a href={fileContentUrl(sectionArtifact.fileId)} download={sectionArtifact.filename}>
                <Download />
                Download section .md
              </a>
            </Button>
          ) : null}
          {lastRunId ? (
            <Button type="button" variant="outline" size="sm" asChild>
              <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: lastRunId }}>
                Open in run
              </Link>
            </Button>
          ) : null}
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
                  This section is empty. Switch to Source to write it, or use the Copilot to
                  generate it.
                </p>
              ) : (
                <LazyMarkdownView markdown={draft} citations={parseRagCitations(node.ragCitations)} />
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

      <EditorStatusBar
        serverWords={node.actualWords}
        draftWords={wordCount(draft)}
        isDirty={isDirty}
        equationCount={equationCount}
        status={status}
        reviewerScore={node.reviewerScore ?? null}
      />
    </div>
  );
}
