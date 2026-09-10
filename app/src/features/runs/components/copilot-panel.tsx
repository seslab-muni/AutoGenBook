import { useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  ChevronDown,
  Cpu,
  FileCheck,
  Layers,
  Play,
  Send,
  Sigma,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { runs as runQueries } from '@/api/queries/runs';
import { outline, useRegenerateOutlineNodeMutation } from '@/api/queries/outline';
import type { Project, Run } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { isLeaf } from '@/features/outline/model';
import { useActiveRun } from '@/features/runs/hooks/use-active-run';
import { useRunStream } from '@/features/runs/hooks/use-run-stream';
import { RunEventLog } from '@/features/runs/components/run-event-log';
import {
  formatCost,
  formatDuration,
  formatElapsed,
  formatTokens,
  RUN_STATUS_LABELS,
} from '@/features/runs/lib/run-format';
import { useUiStore } from '@/stores/ui-store';

const QUICK_ACTIONS = [
  {
    label: 'Draft section',
    icon: Play,
    prompt: 'Draft full section with comprehensive theoretical narrative and lemmas.',
  },
  {
    label: 'Expand proofs',
    icon: Sigma,
    prompt: 'Formalize equations with rigorous stabilizer math & theorem bounds.',
  },
  {
    label: 'Add examples',
    icon: Sparkles,
    prompt: 'Insert intuitive pedagogical example and step-by-step exercise.',
  },
  {
    label: 'Cite sources',
    icon: BookOpen,
    prompt: 'Integrate literature citations and historical background from primary sources.',
  },
] as const;

const TERMINAL_STATUSES = new Set<Run['status']>(['succeeded', 'failed', 'cancelled']);

interface CopilotPanelProps {
  projectId: string;
  project: Project;
  selectedNodeId: string | null;
}

/**
 * The Copilot drawer tab's content (issue #21): quick-action presets and a
 * free-form instruction feed `POST .../outline/{nodeId}/regenerate`, and a
 * live event log/stage timeline/footer track whichever run is currently
 * relevant to the selected node (an active run, or the last one touching
 * this project). Settings (math level, page budget, ...) stay in
 * `NodePropertiesSheet` (#19); citations/review tabs are #20's.
 */
export function CopilotPanel({ projectId, project, selectedNodeId }: CopilotPanelProps) {
  // No `limit` override: shares the route loader's cache entry (`p.$projectId.tsx` already
  // `ensureQueryData`s `outline.flat(projectId)`) instead of firing a second, redundant fetch
  // on every project page load.
  const { data: outlineData } = useQuery(outline.flat(projectId));
  const flat = outlineData?.items ?? [];
  const node = selectedNodeId ? (flat.find((item) => item.id === selectedNodeId) ?? null) : null;

  const openModal = useUiStore((state) => state.openModal);
  const { activeRun } = useActiveRun(projectId);

  const [instruction, setInstruction] = useState('');
  const [trackedRunId, setTrackedRunId] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<{ title: string; detail?: string } | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);

  // Reset per-node UI state whenever the selection changes — adjusting state during render
  // (rather than in a useEffect, which would render the stale state for one frame first) per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes,
  // the same pattern `NewProjectDialog`/`ProjectSettingsDialog` use.
  const [lastSelectedNodeId, setLastSelectedNodeId] = useState(selectedNodeId);
  if (selectedNodeId !== lastSelectedNodeId) {
    setLastSelectedNodeId(selectedNodeId);
    setInstruction('');
    setTrackedRunId(undefined);
    setConflict(null);
  }

  const regenerateMutation = useRegenerateOutlineNodeMutation(projectId, node?.id ?? '');

  // An active run only drives this node's live view when it's a full run (touches every leaf)
  // or a regenerate_section targeting this exact node — an active run for a sibling node stays
  // out of this footer/log, which instead falls back to the project's last known run.
  const relevantActiveRun =
    activeRun && (activeRun.kind === 'full' || activeRun.targetNodeId === node?.id)
      ? activeRun
      : undefined;
  const effectiveRunId = relevantActiveRun?.id ?? trackedRunId ?? project.lastRunId ?? undefined;
  const { data: trackedRun } = useQuery({
    ...runQueries.detail(effectiveRunId ?? ''),
    enabled: Boolean(effectiveRunId),
  });
  const { events, currentStage } = useRunStream(effectiveRunId, projectId);

  const isBusy = activeRun !== undefined;
  const hasCliKey = Boolean(node?.cliKey);
  const hasResumableBaseRun = project.lastRunId != null;
  // Only leaf sections ever get LLM-generated content (book_builder.py's generate_contents walks
  // leaves only); the API rejects a regenerate targeting a non-leaf with a 409 (issue #77), so
  // gate it here too rather than letting the user submit and hit that as a generic error.
  const nodeIsLeaf = node ? isLeaf(node.id, flat) : false;
  const canRegenerate =
    Boolean(node) && nodeIsLeaf && hasCliKey && hasResumableBaseRun && !isBusy;

  let disabledReason: string | null = null;
  if (node) {
    if (!nodeIsLeaf) {
      disabledReason =
        'This is a container node — only leaf sections can be generated. Select a leaf section below it.';
    } else if (!hasCliKey) {
      disabledReason = 'This section has no CLI key yet — it appears after the next full run.';
    } else if (!hasResumableBaseRun) {
      disabledReason = 'No successful prior run to resume from — start a full run first.';
    } else if (isBusy) {
      disabledReason = 'A run is already active for this project.';
    }
  }

  function send(prompt: string) {
    if (!node || !canRegenerate) return;
    setConflict(null);
    regenerateMutation.mutate(prompt.trim() === '' ? undefined : prompt, {
      onSuccess: (run) => {
        setTrackedRunId(run.id);
        setInstruction('');
        toast.success(`Regenerating §${node.sectionNumber}`);
      },
      onError: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          setConflict({
            title: error.problem?.title ?? 'Cannot regenerate right now',
            ...(error.problem?.detail ? { detail: error.problem.detail } : {}),
          });
          return;
        }
        const problem = error instanceof ApiError ? error.problem : undefined;
        toast.error(problem?.detail ?? problem?.title ?? 'Could not start regeneration');
      },
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      send(instruction);
    }
  }

  const stagesSeen = useMemo(() => {
    const seen: string[] = [];
    for (const event of events) {
      if (event.stage && !seen.includes(event.stage)) seen.push(event.stage);
    }
    return seen;
  }, [events]);

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Cpu className="size-8 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground">
          Select a node from the outline tree to interact with the Copilot.
        </p>
      </div>
    );
  }

  const footerStatus = trackedRun ? RUN_STATUS_LABELS[trackedRun.status] : node.status;
  const isRunTerminal = trackedRun ? TERMINAL_STATUSES.has(trackedRun.status) : false;

  let footerTiming: string | null = null;
  if (trackedRun && !isRunTerminal) {
    footerTiming = formatElapsed(trackedRun);
  } else if (trackedRun && isRunTerminal) {
    footerTiming = [
      formatDuration(trackedRun.startedAt, trackedRun.finishedAt),
      formatTokens(trackedRun.totalTokens),
      formatCost(trackedRun.totalCostUsd),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-3">
        <div>
          <p className="text-xs font-semibold text-foreground">
            §{node.sectionNumber} {node.title}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {node.cliKey ? `cli key ${node.cliKey}` : 'Not yet synced from a run'}
          </p>
        </div>

        <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
          <p className="text-[11px] font-bold text-foreground">Quick actions</p>
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_ACTIONS.map((action) => (
              <Button
                key={action.label}
                type="button"
                variant="outline"
                size="sm"
                className="justify-start"
                disabled={!canRegenerate}
                onClick={() => setInstruction(action.prompt)}
              >
                <action.icon className="size-3.5" />
                {action.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2 rounded-xl border p-3">
          <div className="flex items-center justify-between text-xs font-semibold text-foreground">
            <span>Instruction</span>
            <span className="font-mono text-[10px] text-muted-foreground">Ctrl+Enter</span>
          </div>
          <Textarea
            rows={5}
            placeholder="Type instructions for the multi-agent team…"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canRegenerate}
          />
          <div className="flex items-center justify-between">
            {disabledReason ? (
              <span className="text-[10px] text-muted-foreground">{disabledReason}</span>
            ) : (
              <span />
            )}
            <Button
              type="button"
              size="sm"
              disabled={!canRegenerate || regenerateMutation.isPending}
              onClick={() => send(instruction)}
            >
              <Send className="size-3" />
              {regenerateMutation.isPending ? 'Sending…' : 'Regenerate'}
            </Button>
          </div>
        </div>

        {conflict ? (
          <div className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <p className="font-semibold text-destructive">{conflict.title}</p>
            {conflict.detail ? <p className="text-muted-foreground">{conflict.detail}</p> : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => openModal('start-run')}
            >
              Start full run
            </Button>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border">
          <button
            type="button"
            onClick={() => setShowTrace((prev) => !prev)}
            className="flex w-full items-center justify-between bg-muted/50 p-2.5 text-xs font-bold text-foreground"
          >
            <span className="flex items-center gap-1.5">
              <Terminal className="size-3.5" />
              Event log
              <span className="font-mono text-[10px] font-normal text-muted-foreground">
                ({events.length})
              </span>
            </span>
            <ChevronDown
              className={`size-3.5 transition-transform ${showTrace ? 'rotate-180' : ''}`}
            />
          </button>
          {showTrace ? <RunEventLog events={events} className="max-h-48 p-2" /> : null}
        </div>

        <div className="overflow-hidden rounded-xl border">
          <button
            type="button"
            onClick={() => setShowPipeline((prev) => !prev)}
            className="flex w-full items-center justify-between bg-muted/50 p-2.5 text-xs font-bold text-foreground"
          >
            <span className="flex items-center gap-1.5">
              <Layers className="size-3.5" />
              Stage timeline
            </span>
            <ChevronDown
              className={`size-3.5 transition-transform ${showPipeline ? 'rotate-180' : ''}`}
            />
          </button>
          {showPipeline ? (
            <div className="flex flex-wrap gap-1.5 p-2.5">
              {stagesSeen.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">No stages reported yet.</span>
              ) : (
                stagesSeen.map((stage) => (
                  <span
                    key={stage}
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      stage === currentStage
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {stage}
                  </span>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t bg-muted/20 px-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <FileCheck className="size-3 text-success" />
          <span className="font-medium">Status:</span>
          <span className="font-mono font-bold text-foreground">
            {String(footerStatus).replace('_', ' ')}
          </span>
        </span>
        <span className="font-mono">{footerTiming}</span>
      </div>
    </div>
  );
}
