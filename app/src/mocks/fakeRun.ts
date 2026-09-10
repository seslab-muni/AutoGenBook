import { db } from './db';
import type { Run, RunArtifact } from '@/api/types';

/**
 * Every real `setTimeout` handle any in-flight `driveFakeRun` chain is
 * currently waiting on. A test whose assertions stop watching a run before
 * its timeline finishes (e.g. one that only checks the transient "queued"/
 * "drafting" state, or one that fails/times out mid-`waitFor`) used to leave
 * that chain's remaining callbacks armed on the real timer queue with
 * nothing left to cancel them - each is a cheap no-op once `db.reset()`
 * (`seedDatabase`, called in every test's `beforeEach`) makes `db.runs.get`
 * return `undefined` for a run id from a torn-down test, but they still
 * occupy the same real event-loop `setTimeout` queue every *other* real
 * timer in the process shares (React Query's own `refetchInterval` polling
 * included), so they were a source of CI-only flakiness under load rather
 * than a hazard to any single test's own correctness. `resetFakeRuns`
 * (called from `src/test/setup.ts`'s `afterEach`) clears them all between
 * tests so no test ever starts with the previous one's leftovers still
 * ticking.
 */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

export function resetFakeRuns(): void {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
}

function scheduleFakeRunStep(callback: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    callback();
  }, delayMs);
  pendingTimers.add(timer);
}

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
      scheduleFakeRunStep(step, entry.delayMs);
    }
  }

  scheduleFakeRunStep(step, 300);
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
    // The real worker's `"section"` events carry `nodeKey` (== `OutlineNode.cliKey`), not the
    // node's own id — emit the same shape here so `use-run-stream.ts`'s `rememberSectionNode`
    // populates `sectionNodeIds` the way it would against the real API.
    const nodeKey = db.outlineNodes.get(nodeId)?.cliKey ?? nodeId;
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
          payload: { nodeKey },
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
    // Shorter than the other timelines below (still two visibly distinct steps for anyone
    // driving this by hand against the mocks in `pnpm dev`) - `export-dialog.test.tsx`'s own
    // "swaps to a download link" test has to sit through this real delay plus a couple of the
    // dialog's 400ms `refetchInterval` polls on top, entirely on real timers (issue #124 PR
    // #125/#126's CI-only flake), so keeping it short buys real margin against a slow runner
    // without proportionally shrinking every other timeline's pacing too.
    return [
      {
        delayMs: 150,
        status: 'running',
        event: { name: 'stage', stage: 'export', message: 'Rendering LaTeX/PDF export.' },
      },
      {
        delayMs: 350,
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
    // See the `regenerate_section` branch above: `nodeKey` (== `cliKey`), not `nodeId`, is what
    // the real worker sends.
    const nodeKey = db.outlineNodes.get(nodeId)?.cliKey ?? nodeId;
    entries.push({
      delayMs: 500,
      event: {
        name: 'section',
        stage: 'drafting',
        message: `Section drafted.`,
        payload: { nodeKey },
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
