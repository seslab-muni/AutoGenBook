import { db } from './db';
import type { Run, RunArtifact } from '@/api/types';

/**
 * Drives a queued `Run` through `queued -> running -> succeeded`, emitting
 * `stage`/`log`/`section`/`done` events like the real worker + CLI would
 * (`api/worker`, `autogenbook/orchestrator.py`), and mutates the target
 * node's content/status on a `regenerate_section` run. Fire-and-forget:
 * callers observe progress via `db.onRunEvent` / polling `db.runEvents`.
 */
export function driveFakeRun(runId: string): void {
  const run = db.runs.get(runId);
  if (!run) return;

  const timeline = buildTimeline(run);
  let index = 0;

  function step(): void {
    const run = db.runs.get(runId);
    if (!run || run.status === 'cancelled') return;

    const entry = timeline[index];
    if (!entry) return;
    index += 1;

    if (entry.status) {
      db.runs.set(runId, {
        ...run,
        status: entry.status,
        startedAt: entry.status === 'running' && !run.startedAt ? db.now() : run.startedAt,
        finishedAt:
          entry.status === 'succeeded' || entry.status === 'failed' ? db.now() : run.finishedAt,
        totalTokens: entry.status === 'succeeded' ? 128_450 : run.totalTokens,
        totalCostUsd: entry.status === 'succeeded' ? 1.82 : run.totalCostUsd,
      });
    }

    if (entry.event) {
      db.publishRunEvent(runId, entry.event.name, {
        seq: db.nextSeq(runId),
        ts: db.now(),
        level: entry.event.level ?? 'info',
        stage: entry.event.stage ?? '',
        message: entry.event.message,
        payload: entry.event.payload ?? null,
      });
    }

    if (entry.onComplete) {
      entry.onComplete();
    }

    if (index < timeline.length) {
      setTimeout(step, entry.delayMs);
    }
  }

  setTimeout(step, 300);
}

interface TimelineEntry {
  delayMs: number;
  status?: Run['status'];
  event?: {
    name: 'log' | 'stage' | 'section' | 'done';
    message: string;
    level?: string;
    stage?: string;
    payload?: Record<string, unknown>;
  };
  onComplete?: () => void;
}

function buildTimeline(run: Run): TimelineEntry[] {
  if (run.kind === 'regenerate_section' && run.targetNodeId) {
    const nodeId = run.targetNodeId;
    return [
      {
        delayMs: 400,
        status: 'running',
        event: { name: 'stage', stage: 'drafting', message: 'Regenerating section.' },
      },
      {
        delayMs: 900,
        event: {
          name: 'section',
          stage: 'drafting',
          message: 'Section regenerated.',
          payload: { nodeId },
        },
        onComplete: () => completeNode(nodeId),
      },
      {
        delayMs: 0,
        status: 'succeeded',
        event: { name: 'done', stage: 'drafting', message: 'Run succeeded.' },
      },
    ];
  }

  if (run.kind === 'export') {
    return [
      {
        delayMs: 400,
        status: 'running',
        event: { name: 'stage', stage: 'export', message: 'Rendering LaTeX/PDF export.' },
      },
      {
        delayMs: 900,
        status: 'succeeded',
        event: { name: 'done', stage: 'export', message: 'Export succeeded.' },
        onComplete: () => appendExportArtifact(run),
      },
    ];
  }

  const nodeIds = db.outlineFlatForProject(run.projectId).map((node) => node.id);
  const entries: TimelineEntry[] = [
    {
      delayMs: 400,
      status: 'running',
      event: { name: 'stage', stage: 'planning', message: 'Building document graph from outline.' },
    },
    {
      delayMs: 700,
      event: { name: 'stage', stage: 'drafting', message: 'Drafting leaf sections.' },
    },
  ];
  for (const nodeId of nodeIds) {
    entries.push({
      delayMs: 500,
      event: {
        name: 'section',
        stage: 'drafting',
        message: `Section drafted.`,
        payload: { nodeId },
      },
      onComplete: () => completeNode(nodeId),
    });
  }
  entries.push(
    {
      delayMs: 500,
      event: { name: 'stage', stage: 'assembly', message: 'Assembling Markdown output.' },
    },
    {
      delayMs: 0,
      status: 'succeeded',
      event: { name: 'done', stage: 'assembly', message: 'Run succeeded.' },
    },
  );
  return entries;
}

function completeNode(nodeId: string): void {
  const node = db.outlineNodes.get(nodeId);
  if (!node) return;
  // `compiled`, not `review_ready`: the real worker's graph-import step
  // (`api/application/graph_import.py`) sets `NodeStatus.COMPILED` once it
  // folds a finished run's `sections/*.md` back into a node - `review_ready`
  // is reserved for a human reviewer marking a section reviewed and is never
  // set automatically by any backend code path.
  db.outlineNodes.set(nodeId, {
    ...node,
    status: 'compiled',
    actualWords: node.wordBudget,
    contentMarkdown: node.contentMarkdown || `*(Drafted by the fake run for "${node.title}".)*`,
    updatedAt: db.now(),
  });
}

function appendExportArtifact(run: Run): void {
  const format = run.options.outputFormat === 'pdf' ? 'pdf' : 'tex';
  const artifacts: RunArtifact[] = db.runArtifacts.get(run.id) ?? [];
  const fileId = `${run.id}-artifact-${format}`;
  const filename = format === 'pdf' ? 'book.pdf' : 'book.tex';
  artifacts.push({
    kind: format,
    relativePath: filename,
    fileId,
    filename,
    sizeBytes: format === 'pdf' ? 1_048_576 : 65_536,
    contentType: format === 'pdf' ? 'application/pdf' : 'text/x-tex',
  });
  db.runArtifacts.set(run.id, artifacts);
  db.files.set(fileId, {
    id: fileId,
    filename,
    contentType: format === 'pdf' ? 'application/pdf' : 'text/x-tex',
    sizeBytes: format === 'pdf' ? 1_048_576 : 65_536,
    sha256: fileId,
    kind: 'artifact',
    kbEligible: false,
    createdAt: db.now(),
  });
}
