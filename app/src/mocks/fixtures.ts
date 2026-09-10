import { db, type ProjectRow } from './db';
import type {
  AudienceLevel,
  AuthUser,
  FileDto,
  MathLevel,
  NodeStatus,
  OutlineNode,
  OutputFormat,
  Run,
  RunArtifact,
  RunEvent,
  Source,
  SourceType,
} from '@/api/types';

/**
 * Seed data for the flat outline shape (`parentId`/`orderIndex`/`cliKey`) and
 * the File+Source split the real API uses.
 */

/**
 * The one seeded account MSW treats as "signed in" by default (issue #96) — every seed project
 * is owned by this user and every seeded/started run is attributed to them, matching the rest of
 * the mocks' assumption of authenticated access. `GET /auth/me` returns this unless a test
 * overrides the handler to simulate a logged-out session (see `require-auth.test.ts`).
 */
export const MOCK_USER: AuthUser = {
  id: 'user-mock-1',
  email: 'researcher@autogenbook.dev',
  displayName: 'Ada Researcher',
};

/** Not part of `AuthUser` (the API never returns a password) — only `POST /auth/login`'s mock handler checks against this. */
export const MOCK_USER_PASSWORD = 'correcthorsebatterystaple';

const CONTENT_TYPES: Record<SourceType, string> = {
  pdf: 'application/pdf',
  doc: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  txt: 'text/plain',
  slides: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  arxiv: 'application/pdf',
  notes: 'text/markdown',
  bibtex: 'text/x-bibtex',
  latex: 'text/x-tex',
  url: 'text/html',
  book: 'application/pdf',
  dataset: 'text/csv',
};

const KB_ELIGIBLE_TYPES = new Set<SourceType>(['pdf', 'doc', 'ppt', 'md', 'txt']);

function fakeSha256(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').repeat(8).slice(0, 64);
}

interface SeedFile {
  id: string;
  filename: string;
  sizeBytes: number;
  type: SourceType;
  authors?: string;
  year?: string;
  doi?: string;
  chunksCount: number;
  createdAt: string;
}

interface SeedOutlineNode {
  id: string;
  title: string;
  summary: string;
  status: NodeStatus;
  targetPages: number;
  wordBudget: number;
  actualWords: number;
  equationDensityLevel: number;
  mathLevel: MathLevel;
  subPrompt?: string;
  contentMarkdown: string;
  contentLatex: string;
  /** `OutlineNode.ragCitations` is untyped freeform JSON in the API's own schema; fixtures still model realistic entries. */
  ragCitations: Record<string, unknown>[];
  children?: SeedOutlineNode[];
}

interface SeedProject {
  id: string;
  /**
   * Whether `MOCK_USER` owns this project — `true` (default when omitted) attributes it to
   * them, matching every other seeded assumption of authenticated access; `false` simulates a
   * legacy project predating accounts (`ownerId`/`ownerName` both `null`), so the "—" fallback
   * in `ProjectCard`/`AppHeader` has seeded coverage too.
   */
  owned?: boolean;
  title: string;
  subtitle: string;
  authors: string[];
  topic: string;
  targetAudience: AudienceLevel;
  totalPagesBudget: number;
  equationFrequencyLevel: number;
  outputFormat: OutputFormat;
  createdAt: string;
  updatedAt: string;
  files: SeedFile[];
  outline: SeedOutlineNode[];
  /** Whether a run has already indexed the sources / drafted content (affects Source.status). */
  hasCompletedRun: boolean;
}

function flattenOutline(
  nodes: SeedOutlineNode[],
  projectId: string,
  parentId: string | null,
  depth: number,
  numberPrefix: string,
  cliPrefix: string,
  timestamp: string,
): (OutlineNode & { projectId: string })[] {
  const rows: (OutlineNode & { projectId: string })[] = [];
  nodes.forEach((node, index) => {
    const sectionNumber = numberPrefix ? `${numberPrefix}.${index + 1}` : `${index + 1}`;
    const cliKey = cliPrefix ? `${cliPrefix}-${index + 1}` : `${index + 1}`;
    rows.push({
      projectId,
      id: node.id,
      parentId,
      orderIndex: index,
      cliKey,
      title: node.title,
      summary: node.summary,
      level: depth,
      sectionNumber,
      status: node.status,
      targetPages: node.targetPages,
      wordBudget: node.wordBudget,
      actualWords: node.actualWords,
      equationDensityLevel: node.equationDensityLevel,
      mathLevel: node.mathLevel,
      subPrompt: node.subPrompt ?? null,
      contentMarkdown: node.contentMarkdown,
      contentLatex: node.contentLatex,
      ragCitations: node.ragCitations,
      reviewerScore: null,
      reviewerNotes: null,
      structureLocked: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (node.children?.length) {
      rows.push(
        ...flattenOutline(
          node.children,
          projectId,
          node.id,
          depth + 1,
          sectionNumber,
          cliKey,
          timestamp,
        ),
      );
    }
  });
  return rows;
}

function seedProject(seed: SeedProject): void {
  const owned = seed.owned ?? true;
  const projectRow: ProjectRow = {
    id: seed.id,
    ownerId: owned ? MOCK_USER.id : null,
    ownerName: owned ? MOCK_USER.displayName : null,
    title: seed.title,
    subtitle: seed.subtitle,
    authors: seed.authors,
    topic: seed.topic,
    targetAudience: seed.targetAudience,
    totalPagesBudget: seed.totalPagesBudget,
    equationFrequencyLevel: seed.equationFrequencyLevel,
    doConsiderOutline: true,
    doConsiderPreviousSections: true,
    outputFormat: seed.outputFormat,
    maxOutlineLevels: 3,
    additionalRequirements: null,
    lastRunId: null,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
  };
  db.projects.set(seed.id, projectRow);

  for (const file of seed.files) {
    const fileDto: FileDto = {
      id: file.id,
      filename: file.filename,
      contentType: CONTENT_TYPES[file.type],
      sizeBytes: file.sizeBytes,
      sha256: fakeSha256(file.filename),
      kind: 'upload',
      kbEligible: KB_ELIGIBLE_TYPES.has(file.type),
      createdAt: file.createdAt,
    };
    db.files.set(file.id, fileDto);

    const source: Source & { projectId: string } = {
      projectId: seed.id,
      id: `${file.id}-source`,
      fileId: file.id,
      name: file.filename,
      sizeBytes: file.sizeBytes,
      type: file.type,
      chunksCount: seed.hasCompletedRun ? file.chunksCount : null,
      status: seed.hasCompletedRun ? 'indexed' : 'ready',
      uploadDate: file.createdAt,
      authors: file.authors ?? null,
      year: file.year ?? null,
      doi: file.doi ?? null,
      url: null,
      description: null,
    };
    db.sources.set(source.id, source);
  }

  const flatOutline = flattenOutline(seed.outline, seed.id, null, 1, '', '', seed.updatedAt);
  for (const node of flatOutline) {
    db.outlineNodes.set(node.id, node);
  }

  if (seed.hasCompletedRun) {
    const runId = `${seed.id}-run-1`;
    const finishedAt = seed.updatedAt;
    const run: Run = {
      id: runId,
      projectId: seed.id,
      kind: 'full',
      status: 'succeeded',
      options: {
        outline: 'project',
        outputFormat: seed.outputFormat,
        allowSubdivision: false,
        enableWebRag: false,
        auditBook: false,
        auditBookMode: 'warn',
        legacyTex: false,
        rebuildKb: false,
        failFastSchema: false,
        resume: false,
        exportTexOnly: false,
      },
      baseRunId: null,
      targetNodeId: null,
      exitCode: 0,
      error: null,
      totalTokens: 482_311,
      totalCostUsd: 6.42,
      resumable: true,
      // Not retryable: only a `failed`/`cancelled` full run is (issue #124) - this seed run
      // succeeded.
      retryable: false,
      queuedAt: seed.createdAt,
      startedAt: seed.createdAt,
      finishedAt,
      startedById: owned ? MOCK_USER.id : null,
      startedByName: owned ? MOCK_USER.displayName : null,
    };
    db.runs.set(runId, run);
    projectRow.lastRunId = runId;

    const events: RunEvent[] = [
      {
        seq: 1,
        ts: seed.createdAt,
        level: 'info',
        stage: 'planning',
        message: 'Building document graph from outline.',
      },
      {
        seq: 2,
        ts: seed.createdAt,
        level: 'info',
        stage: 'drafting',
        message: 'Drafting leaf sections.',
      },
      {
        seq: 3,
        ts: finishedAt,
        level: 'info',
        stage: 'assembly',
        message: 'Assembling Markdown output.',
      },
      { seq: 4, ts: finishedAt, level: 'info', stage: 'done', message: 'Run succeeded.' },
    ];
    db.runEvents.set(runId, events);

    const slug = seed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const artifacts: RunArtifact[] = [
      {
        kind: 'markdown',
        relativePath: 'book.md',
        fileId: `${runId}-artifact-md`,
        filename: `${slug}.md`,
        sizeBytes: 245_760,
        contentType: 'text/markdown',
      },
      // Markdown/BibTeX exist on every succeeded full run with no export needed - see issue #22.
      {
        kind: 'bib',
        relativePath: 'refs.bib',
        fileId: `${runId}-artifact-bib`,
        filename: `${slug}.bib`,
        sizeBytes: 8_192,
        contentType: 'text/x-bibtex',
      },
      {
        kind: 'run_meta',
        relativePath: 'run_meta.json',
        fileId: `${runId}-artifact-meta`,
        filename: 'run_meta.json',
        sizeBytes: 2_048,
        contentType: 'application/json',
      },
      {
        kind: 'llm_usage',
        relativePath: 'llm_usage.jsonl',
        fileId: `${runId}-artifact-usage`,
        filename: 'llm_usage.jsonl',
        sizeBytes: 4_096,
        contentType: 'application/jsonl',
      },
      {
        kind: 'log',
        relativePath: 'run.log',
        fileId: `${runId}-artifact-log`,
        filename: 'run.log',
        sizeBytes: 1_024,
        contentType: 'text/plain',
      },
      // The first leaf node's own Markdown, keyed by its `cliKey` — backs the section editor's
      // "Download section .md" button (issue #22).
      {
        kind: 'section',
        relativePath: `sections/${flatOutline[1]?.cliKey ?? '1-1'}.md`,
        fileId: `${runId}-artifact-section-1-1`,
        filename: `${flatOutline[1]?.cliKey ?? '1-1'}.md`,
        sizeBytes: 6_144,
        contentType: 'text/markdown',
      },
    ];
    db.runArtifacts.set(runId, artifacts);
    for (const artifact of artifacts) {
      db.files.set(artifact.fileId, {
        id: artifact.fileId,
        filename: artifact.filename,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        sha256: fakeSha256(artifact.fileId),
        kind: 'artifact',
        kbEligible: false,
        createdAt: finishedAt,
      });
    }
  }
}

const CONSENSUS_QUANTUM: SeedProject = {
  id: 'book-consensus-quantum-2026',
  title: 'Distributed Consensus & Quantum Fault Tolerance',
  subtitle: 'From Asynchronous BFT Protocols to Surface-Code Syndrome Extraction',
  authors: ['Prof. Elena Rostova', 'Dr. Marcus Vance', 'AutoGenBook Multi-Agent Team'],
  topic: 'Modern Byzantine Fault Tolerance in Hybrid Classical-Quantum Distributed Systems',
  targetAudience: 'graduate',
  totalPagesBudget: 420,
  equationFrequencyLevel: 4,
  outputFormat: 'latex',
  createdAt: '2026-08-10T09:00:00Z',
  updatedAt: '2026-08-25T17:30:00Z',
  hasCompletedRun: true,
  files: [
    {
      id: 'file-lamport-1982',
      filename: 'Lamport_1982_ByzantineGenerals.pdf',
      sizeBytes: 1_468_006,
      type: 'pdf',
      chunksCount: 48,
      authors: 'Leslie Lamport, Robert Shostak',
      year: '1982',
      createdAt: '2026-08-10T09:05:00Z',
    },
    {
      id: 'file-quantum-consensus-report',
      filename: 'Quantum_Consensus_Technical_Report.docx',
      sizeBytes: 870_400,
      type: 'doc',
      chunksCount: 38,
      authors: 'Dr. Marcus Vance',
      year: '2026',
      createdAt: '2026-08-11T09:05:00Z',
    },
    {
      id: 'file-mit-6824-slides',
      filename: 'MIT_6.824_Distributed_Systems_Slides.pptx',
      sizeBytes: 5_662_310,
      type: 'ppt',
      chunksCount: 160,
      authors: 'MIT CSAIL Group',
      year: '2025',
      createdAt: '2026-08-12T09:05:00Z',
    },
    {
      id: 'file-bft-surface-code-specs',
      filename: 'BFT_Surface_Code_Syndrome_Specs.md',
      sizeBytes: 327_680,
      type: 'md',
      chunksCount: 28,
      authors: 'Prof. Elena Rostova',
      year: '2026',
      createdAt: '2026-08-14T09:05:00Z',
    },
    {
      id: 'file-quantum-syndrome-log',
      filename: 'Quantum_Syndrome_Defects_RawLog.txt',
      sizeBytes: 184_320,
      type: 'txt',
      chunksCount: 14,
      createdAt: '2026-08-15T09:05:00Z',
    },
    {
      id: 'file-castro-liskov-pbft',
      filename: 'Castro_Liskov_PBFT_TOCS.pdf',
      sizeBytes: 2_202_009,
      type: 'pdf',
      chunksCount: 64,
      authors: 'Miguel Castro, Barbara Liskov',
      year: '2002',
      createdAt: '2026-08-16T09:05:00Z',
    },
  ],
  outline: [
    {
      id: 'ch-1',
      title: 'Foundations of Classical Asynchronous Consensus',
      summary: 'Establish the FLP impossibility theorem and classical partial synchrony models.',
      status: 'compiled',
      targetPages: 45,
      wordBudget: 15000,
      actualWords: 14820,
      equationDensityLevel: 4,
      mathLevel: 'rigorous',
      contentMarkdown:
        '# Chapter 1: Foundations of Classical Asynchronous Consensus\n\n' +
        'Consensus in distributed systems requires a set of independent processes $\\mathcal{P} = \\{p_1, p_2, \\dots, p_n\\}$ to agree upon a single state transition or data value $v \\in \\mathcal{V}$ despite partial network partition and adversarial process corruption.\n\n' +
        '## 1.1 The Classical System Model & Adversary Assumptions\n\n' +
        'We consider an asynchronous network where message transmission delays are unbounded but finite. The adversary may corrupt up to $f$ processes under Byzantine conditions.\n\n' +
        '### Theorem 1.1 (Fischer-Lynch-Paterson Impossibility)\n' +
        'In an asynchronous network with even a single unannounced fail-stop crash ($f=1$), deterministic consensus is unsolvable.',
      contentLatex:
        '\\chapter{Foundations of Classical Asynchronous Consensus}\n\\label{ch:classical-consensus}\n' +
        'Consensus in distributed systems requires a set of independent processes...',
      ragCitations: [
        {
          id: 'c-1',
          sourceDoc: 'Lamport_1982_ByzantineGenerals.pdf',
          pageNumber: 4,
          sectionSnippet:
            'A set of generals of the Byzantine army camped outside an enemy city must decide upon a common battle plan...',
          relevanceScore: 0.98,
          authorYear: 'Lamport et al., 1982',
        },
      ],
      children: [
        {
          id: 'sec-1-1',
          title: 'Formal Safety and Liveness Definitions',
          summary: 'Define agreement, validity and termination for Byzantine consensus.',
          status: 'compiled',
          targetPages: 12,
          wordBudget: 4200,
          actualWords: 4190,
          equationDensityLevel: 4,
          mathLevel: 'rigorous',
          contentMarkdown:
            '### 1.1 Formal Safety and Liveness Definitions\n\n' +
            'A protocol $\\Pi$ satisfies **Byzantine Consensus** if for all executions the following three properties hold:\n\n' +
            '1. **Agreement (Safety):** If correct processes $p_i$ and $p_j$ decide on values $v_i, v_j$, then $v_i = v_j$.\n' +
            '2. **Validity:** If all correct processes propose $v_0$, then any decided value must be $v_0$.\n' +
            '3. **Termination (Liveness):** Every correct process eventually decides on some value $v \\in \\mathcal{V}$.',
          contentLatex:
            '\\section{Formal Safety and Liveness Definitions}\nA protocol $\\Pi$ satisfies Byzantine Consensus...',
          ragCitations: [
            {
              id: 'c-2',
              sourceDoc: 'Castro_Liskov_PBFT_TOCS.pdf',
              pageNumber: 3,
              sectionSnippet:
                'Safety means that the service satisfies its state-machine specification, behaving as a centralized implementation...',
              relevanceScore: 0.94,
              authorYear: 'Castro & Liskov, 2002',
            },
          ],
        },
        {
          id: 'sec-1-2',
          title: 'Byzantine Quorum Intersection & Threshold Bounds',
          summary: 'Derive the n >= 3f + 1 resilience bound from quorum intersection.',
          status: 'compiled',
          targetPages: 18,
          wordBudget: 5800,
          actualWords: 5750,
          equationDensityLevel: 5,
          mathLevel: 'formal_proof',
          contentMarkdown:
            '### 1.2 Byzantine Quorum Intersection & Threshold Bounds\n\n' +
            'Let $n$ denote total nodes and $f$ denote the maximum number of Byzantine faulty nodes.\n\n' +
            '$$n_{\\min} = 3f + 1$$',
          contentLatex:
            '\\section{Byzantine Quorum Intersection}\n\\begin{equation}\n|\\mathcal{Q}_1 \\cap \\mathcal{Q}_2| \\ge f + 1 \\implies n \\ge 3f + 1\n\\end{equation}',
          ragCitations: [
            {
              id: 'c-3',
              sourceDoc: 'Castro_Liskov_PBFT_TOCS.pdf',
              pageNumber: 8,
              sectionSnippet:
                'The system can tolerate up to f faulty nodes in a system with 3f+1 replicas because 2f+1 replicas intersect in at least one correct node...',
              relevanceScore: 0.99,
              authorYear: 'Castro & Liskov, 2002',
            },
          ],
        },
      ],
    },
    {
      id: 'ch-2',
      title: 'Quantum State Sharing & Stabilizer Codes',
      summary:
        'Formulate Pauli group stabilizers and quantum secret sharing schemes for distributed state validation.',
      status: 'review_ready',
      targetPages: 55,
      wordBudget: 18000,
      actualWords: 16400,
      equationDensityLevel: 5,
      mathLevel: 'formal_proof',
      contentMarkdown:
        '# Chapter 2: Quantum State Sharing & Stabilizer Codes\n\n' +
        'In contrast to classical bit replication, the **No-Cloning Theorem** prevents perfect copying of an arbitrary unknown quantum state $|\\psi\\rangle = \\alpha|0\\rangle + \\beta|1\\rangle$.',
      contentLatex:
        '\\chapter{Quantum State Sharing & Stabilizer Codes}\n\\label{ch:quantum-stabilizer}\nIn contrast to classical bit replication, the No-Cloning Theorem prevents perfect copying...',
      ragCitations: [
        {
          id: 'c-4',
          sourceDoc: 'Fowler_2012_SurfaceCodesQuantumComputing.pdf',
          pageNumber: 12,
          sectionSnippet:
            'Stabilizer operators correspond to measurements of commuting observables on a lattice of data qubits...',
          relevanceScore: 0.96,
          authorYear: 'Fowler et al., 2012',
        },
      ],
      children: [
        {
          id: 'sec-2-1',
          title: 'Surface Code Syndrome Extraction Cycles',
          summary:
            'Vertex/plaquette stabilizer measurements and minimum-weight perfect matching decoding.',
          status: 'drafting',
          targetPages: 22,
          wordBudget: 7200,
          actualWords: 6800,
          equationDensityLevel: 5,
          mathLevel: 'formal_proof',
          contentMarkdown:
            '### 2.1 Surface Code Syndrome Extraction Cycles\n\n' +
            'The 2D surface code on a rotated lattice of distance $d$ encodes $k=1$ logical qubit into $n = d^2 + (d-1)^2$ physical qubits.',
          contentLatex:
            '\\section{Surface Code Syndrome Extraction}\n\\begin{equation}\nA_v = \\prod_{i \\in v} X_i, \\quad B_p = \\prod_{j \\in p} Z_j\n\\end{equation}',
          ragCitations: [
            {
              id: 'c-5',
              sourceDoc: 'Fowler_2012_SurfaceCodesQuantumComputing.pdf',
              pageNumber: 26,
              sectionSnippet:
                'Topological error correction decodes syndromes by finding the minimum-weight matching of boundary defect pairs...',
              relevanceScore: 0.99,
              authorYear: 'Fowler et al., 2012',
            },
          ],
        },
        {
          id: 'sec-2-2',
          title: 'Quantum Byzantine Agreement (QBA) Protocols',
          summary: 'Queued for recursive generation by the multi-agent drafting pipeline.',
          status: 'not_started',
          targetPages: 20,
          wordBudget: 6500,
          actualWords: 0,
          equationDensityLevel: 4,
          mathLevel: 'rigorous',
          contentMarkdown:
            '*(This section is queued for recursive generation by the Multi-Agent Drafting Pipeline.)*',
          contentLatex:
            '\\section{Quantum Byzantine Agreement Protocols}\n% Queued for multi-agent synthesis',
          ragCitations: [],
        },
      ],
    },
    {
      id: 'ch-3',
      title: 'Hybrid Classical-Quantum Distributed Architectures',
      summary: 'Synthesize entanglement routing with classical PBFT leader rotation.',
      status: 'not_started',
      targetPages: 60,
      wordBudget: 20000,
      actualWords: 0,
      equationDensityLevel: 4,
      mathLevel: 'applied',
      contentMarkdown: '*(Chapter queued for hierarchical planning)*',
      contentLatex: '\\chapter{Hybrid Classical-Quantum Distributed Architectures}',
      ragCitations: [],
      children: [
        {
          id: 'sec-3-1',
          title: 'Entanglement-Swapping Mesh Networks',
          summary: 'Repeater-based entanglement distribution across a distributed mesh.',
          status: 'not_started',
          targetPages: 25,
          wordBudget: 8000,
          actualWords: 0,
          equationDensityLevel: 4,
          mathLevel: 'rigorous',
          contentMarkdown: '',
          contentLatex: '',
          ragCitations: [],
        },
        {
          id: 'sec-3-2',
          title: 'Fault-Tolerant Leader Election via GHZ States',
          summary: 'Multipartite entanglement for distributed leader election.',
          status: 'not_started',
          targetPages: 25,
          wordBudget: 8000,
          actualWords: 0,
          equationDensityLevel: 4,
          mathLevel: 'formal_proof',
          contentMarkdown: '',
          contentLatex: '',
          ragCitations: [],
        },
      ],
    },
  ],
};

const REINFORCEMENT_LEARNING: SeedProject = {
  id: 'book-reinforcement-learning',
  // A legacy project predating accounts — exercises the "—" owner fallback.
  owned: false,
  title: 'Deep Reinforcement Learning & Multi-Agent Planning',
  subtitle: 'From Policy Gradients to Game-Theoretic Multi-Agent Systems',
  authors: ['Dr. Arthur Hayes', 'Prof. Sarah Chen'],
  topic: 'Hierarchical Multi-Agent RL, Bellman Contractions, and Value Factorization',
  targetAudience: 'graduate',
  totalPagesBudget: 350,
  equationFrequencyLevel: 5,
  outputFormat: 'latex',
  createdAt: '2026-07-19T09:00:00Z',
  updatedAt: '2026-08-20T14:10:00Z',
  hasCompletedRun: false,
  files: [
    {
      id: 'file-sutton-barto',
      filename: 'Sutton_Barto_RL_2018.pdf',
      sizeBytes: 13_002_650,
      type: 'pdf',
      chunksCount: 340,
      authors: 'Richard S. Sutton, Andrew G. Barto',
      year: '2018',
      createdAt: '2026-07-19T09:05:00Z',
    },
    {
      id: 'file-marl-coordination',
      filename: 'MARL_Coordination_Architectures.docx',
      sizeBytes: 1_153_434,
      type: 'doc',
      chunksCount: 32,
      authors: 'Dr. Arthur Hayes',
      year: '2026',
      createdAt: '2026-07-22T09:05:00Z',
    },
    {
      id: 'file-deeprl-lecture',
      filename: 'DeepRL_Policy_Gradients_Lecture.pptx',
      sizeBytes: 7_130_316,
      type: 'ppt',
      chunksCount: 140,
      authors: 'Prof. Sarah Chen',
      year: '2026',
      createdAt: '2026-07-25T09:05:00Z',
    },
    {
      id: 'file-spinningup-notes',
      filename: 'OpenAI_SpinningUp_DeepRL_Notes.md',
      sizeBytes: 1_258_291,
      type: 'md',
      chunksCount: 45,
      authors: 'Josh Achiam',
      createdAt: '2026-08-02T09:05:00Z',
    },
    {
      id: 'file-bellman-benchmarks',
      filename: 'Bellman_Contractions_Benchmarks.txt',
      sizeBytes: 348_160,
      type: 'txt',
      chunksCount: 22,
      createdAt: '2026-08-05T09:05:00Z',
    },
  ],
  outline: [
    {
      id: 'rl-ch-1',
      title: 'Markov Decision Processes and Dynamic Programming',
      summary: 'Bellman optimality, contraction mappings, and value iteration.',
      status: 'compiled',
      targetPages: 40,
      wordBudget: 13000,
      actualWords: 12900,
      equationDensityLevel: 5,
      mathLevel: 'formal_proof',
      contentMarkdown:
        '# Chapter 1: Markov Decision Processes and Dynamic Programming\n\n' +
        'An MDP is defined as a 5-tuple $(\\mathcal{S}, \\mathcal{A}, \\mathcal{P}, \\mathcal{R}, \\gamma)$.\n\n' +
        '## 1.1 The Bellman Optimality Equation\n' +
        '### Theorem 1.1 (Banach Fixed-Point Contraction)\n' +
        'The Bellman optimality operator $\\mathcal{T}^*$ is a $\\gamma$-contraction in supremum norm.',
      contentLatex:
        '\\chapter{Markov Decision Processes}\n\\label{ch:mdp}\nAn MDP is defined as a 5-tuple...',
      ragCitations: [
        {
          id: 'c-rl-1',
          sourceDoc: 'Sutton_Barto_RL_2018.pdf',
          pageNumber: 58,
          sectionSnippet:
            'The Bellman optimality equations are non-linear systems of equations whose unique solution is the optimal value function...',
          relevanceScore: 0.99,
          authorYear: 'Sutton & Barto, 2018',
        },
      ],
      children: [
        {
          id: 'rl-sec-1-1',
          title: 'Policy Iteration & Monotonic Improvement',
          summary: 'The policy improvement theorem and its convergence guarantee.',
          status: 'compiled',
          targetPages: 18,
          wordBudget: 5500,
          actualWords: 5400,
          equationDensityLevel: 5,
          mathLevel: 'formal_proof',
          contentMarkdown:
            '### 1.1 Policy Iteration & Monotonic Improvement\n\n' +
            'Given policy $\\pi_k$, policy improvement yields $\\pi_{k+1}(s) = \\arg\\max_a q_{\\pi_k}(s, a)$.',
          contentLatex: '\\section{Policy Iteration}\nGiven policy $\\pi_k$...',
          ragCitations: [],
        },
      ],
    },
    {
      id: 'rl-ch-2',
      title: 'Multi-Agent Value Factorization & Game Theory',
      summary: 'Individual-Global-Max factorization for cooperative MARL.',
      status: 'drafting',
      targetPages: 50,
      wordBudget: 16000,
      actualWords: 9200,
      equationDensityLevel: 5,
      mathLevel: 'rigorous',
      contentMarkdown:
        '# Chapter 2: Multi-Agent Value Factorization\n\n' +
        'In cooperative multi-agent reinforcement learning (MARL), $N$ agents jointly choose action $\\mathbf{a}$ to maximize team reward.',
      contentLatex: '\\chapter{Multi-Agent Value Factorization}',
      ragCitations: [],
    },
  ],
};

const GEOMETRIC_DEEP_LEARNING: SeedProject = {
  id: 'book-geometric-deep-learning',
  title: 'Geometric Deep Learning: Grids, Groups, Graphs & Geodesics',
  subtitle: 'A Unifying Symmetry Perspective from the Erlangen Programme to Gauge Transformers',
  authors: ['Prof. Michael M. Bronstein', 'Dr. Joan Bruna', 'AutoGenBook AI Synthesis Team'],
  topic: 'Equivariant Neural Networks, Lie Groups, Sheaf Neural Networks, and Riemannian Manifolds',
  targetAudience: 'phd_researcher',
  totalPagesBudget: 480,
  equationFrequencyLevel: 5,
  outputFormat: 'latex',
  createdAt: '2026-08-01T09:00:00Z',
  updatedAt: '2026-08-25T11:20:00Z',
  hasCompletedRun: false,
  files: [
    {
      id: 'file-bronstein-blueprint',
      filename: 'Bronstein_2021_GeometricDeepLearning_Blueprint.pdf',
      sizeBytes: 19_503_022,
      type: 'pdf',
      chunksCount: 420,
      authors: 'Bronstein, Bruna, Cohen, Velickovic',
      year: '2021',
      doi: '10.48550/arXiv.2104.13478',
      createdAt: '2026-08-01T09:05:00Z',
    },
    {
      id: 'file-equivariant-layers-spec',
      filename: 'Equivariant_Layers_Specification.docx',
      sizeBytes: 942_080,
      type: 'doc',
      chunksCount: 36,
      authors: 'Dr. Joan Bruna',
      year: '2025',
      createdAt: '2026-08-03T09:05:00Z',
    },
    {
      id: 'file-gauge-equivariance-keynote',
      filename: 'Gauge_Equivariance_Keynote.pptx',
      sizeBytes: 9_646_899,
      type: 'ppt',
      chunksCount: 175,
      authors: 'Michael M. Bronstein',
      year: '2026',
      createdAt: '2026-08-08T09:05:00Z',
    },
    {
      id: 'file-sheaf-diffusion-notes',
      filename: 'Cellular_Sheaf_Diffusion_Notes.md',
      sizeBytes: 655_360,
      type: 'md',
      chunksCount: 48,
      createdAt: '2026-08-12T09:05:00Z',
    },
    {
      id: 'file-erlangen-axioms',
      filename: 'Erlangen_Programme_Symmetry_Axioms.txt',
      sizeBytes: 97_280,
      type: 'txt',
      chunksCount: 12,
      authors: 'Felix Klein / Annotated',
      year: '1872',
      createdAt: '2026-08-15T09:05:00Z',
    },
  ],
  outline: [
    {
      id: 'gdl-ch-1',
      title: 'Symmetries, Groups, and Equivariant Maps',
      summary: "Klein's Erlangen Programme recast as equivariant operators between vector bundles.",
      status: 'compiled',
      targetPages: 48,
      wordBudget: 15500,
      actualWords: 15200,
      equationDensityLevel: 5,
      mathLevel: 'formal_proof',
      contentMarkdown:
        '# Chapter 1: Symmetries, Groups, and Equivariant Maps\n\n' +
        "Following Felix Klein's Erlangen Programme (1872), geometry is the study of invariants under transformation groups.\n\n" +
        '## 1.1 Equivariance and Invariance Definitions\n' +
        'An operator $\\Phi: \\mathcal{X} \\to \\mathcal{Y}$ is said to be **$G$-equivariant** if $\\Phi(\\rho_X(g) f) = \\rho_Y(g) \\Phi(f)$.',
      contentLatex:
        "\\chapter{Symmetries, Groups, and Equivariant Maps}\n\\label{ch:symmetries}\nFollowing Felix Klein's Erlangen Programme (1872)...",
      ragCitations: [
        {
          id: 'c-gdl-1',
          sourceDoc: 'Bronstein_2021_GeometricDeepLearning_Blueprint.pdf',
          pageNumber: 14,
          sectionSnippet:
            'Geometric Deep Learning is an attempt to geometrize deep learning by applying symmetry and invariance principles...',
          relevanceScore: 0.99,
          authorYear: 'Bronstein et al., 2021',
        },
      ],
      children: [
        {
          id: 'gdl-sec-1-1',
          title: 'Lie Algebra Representations & Harmonic Analysis',
          summary: 'Peter-Weyl decomposition and Wigner D-matrices for steerable filters.',
          status: 'compiled',
          targetPages: 20,
          wordBudget: 6200,
          actualWords: 6150,
          equationDensityLevel: 5,
          mathLevel: 'formal_proof',
          contentMarkdown:
            '### 1.1 Lie Algebra Representations & Harmonic Analysis\n\n' +
            'For compact Lie groups such as $SO(3)$ or $SU(2)$, the Peter-Weyl theorem guarantees decomposition into irreducible representations.',
          contentLatex: '\\section{Lie Algebra Representations}',
          ragCitations: [],
        },
      ],
    },
    {
      id: 'gdl-ch-2',
      title: 'Gauge Equivariant Mesh Convolutions and Sheaf Laplacians',
      summary: 'Parallel transport between local tangent frames on Riemannian manifolds.',
      status: 'drafting',
      targetPages: 55,
      wordBudget: 17500,
      actualWords: 8400,
      equationDensityLevel: 5,
      mathLevel: 'formal_proof',
      contentMarkdown:
        '# Chapter 2: Gauge Equivariant Mesh Convolutions\n\n' +
        'On a non-flat Riemannian manifold $(\\mathcal{M}, g)$, there is in general no global coordinate system.',
      contentLatex: '\\chapter{Gauge Equivariant Mesh Convolutions}',
      ragCitations: [],
    },
  ],
};

export const SEED_PROJECTS = [CONSENSUS_QUANTUM, REINFORCEMENT_LEARNING, GEOMETRIC_DEEP_LEARNING];

export function seedDatabase(): void {
  db.reset();
  for (const project of SEED_PROJECTS) {
    seedProject(project);
  }
}
