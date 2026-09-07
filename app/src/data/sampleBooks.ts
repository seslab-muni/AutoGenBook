import { BookProject } from '../types';

export const SAMPLE_BOOKS: BookProject[] = [
  {
    id: 'book-consensus-quantum-2026',
    title: 'Distributed Consensus & Quantum Fault Tolerance',
    subtitle: 'From Asynchronous BFT Protocols to Surface-Code Syndrome Extraction',
    authors: ['Prof. Elena Rostova', 'Dr. Marcus Vance', 'AutoGenBook Multi-Agent Team'],
    topic: 'Modern Byzantine Fault Tolerance in Hybrid Classical-Quantum Distributed Systems',
    targetAudience: 'graduate',
    totalPagesBudget: 420,
    equationFrequencyLevel: 4,
    doConsiderOutline: true,
    doConsiderPreviousSections: true,
    outputFormat: 'latex',
    createdAt: '2026-08-10',
    updatedAt: '2026-08-25',
    sources: [
      {
        id: 'src-1',
        name: 'Lamport_1982_ByzantineGenerals.pdf',
        size: '1.4 MB',
        type: 'pdf',
        chunksCount: 48,
        uploadDate: '2026-08-10',
        status: 'indexed',
        authors: 'Leslie Lamport, Robert Shostak',
        year: '1982',
      },
      {
        id: 'src-2',
        name: 'Quantum_Consensus_Technical_Report.docx',
        size: '850 KB',
        type: 'doc',
        chunksCount: 38,
        uploadDate: '2026-08-11',
        status: 'indexed',
        authors: 'Dr. Marcus Vance',
        year: '2026',
      },
      {
        id: 'src-3',
        name: 'MIT_6.824_Distributed_Systems_Slides.pptx',
        size: '5.4 MB',
        type: 'ppt',
        chunksCount: 160,
        uploadDate: '2026-08-12',
        status: 'indexed',
        authors: 'MIT CSAIL Group',
        year: '2025',
      },
      {
        id: 'src-4',
        name: 'BFT_Surface_Code_Syndrome_Specs.md',
        size: '320 KB',
        type: 'md',
        chunksCount: 28,
        uploadDate: '2026-08-14',
        status: 'indexed',
        authors: 'Prof. Elena Rostova',
        year: '2026',
      },
      {
        id: 'src-5',
        name: 'Quantum_Syndrome_Defects_RawLog.txt',
        size: '180 KB',
        type: 'txt',
        chunksCount: 14,
        uploadDate: '2026-08-15',
        status: 'indexed',
      },
      {
        id: 'src-6',
        name: 'Castro_Liskov_PBFT_TOCS.pdf',
        size: '2.1 MB',
        type: 'pdf',
        chunksCount: 64,
        uploadDate: '2026-08-16',
        status: 'indexed',
        authors: 'Miguel Castro, Barbara Liskov',
        year: '2002',
      },
    ],
    outline: [
      {
        id: 'ch-1',
        title: 'Foundations of Classical Asynchronous Consensus',
        sectionNumber: '1',
        level: 1,
        status: 'compiled',
        targetPages: 45,
        wordBudget: 15000,
        actualWords: 14820,
        equationDensityLevel: 4,
        mathLevel: 'rigorous',
        subPrompt: 'Establish the FLP impossibility theorem and classical partial synchrony models.',
        contentMarkdown: `# Chapter 1: Foundations of Classical Asynchronous Consensus

Consensus in distributed systems requires a set of independent processes $\\mathcal{P} = \\{p_1, p_2, \\dots, p_n\\}$ to agree upon a single state transition or data value $v \\in \\mathcal{V}$ despite partial network partition and adversarial process corruption.

## 1.1 The Classical System Model & Adversary Assumptions

We consider an asynchronous network where message transmission delays are unbounded but finite. The adversary may corrupt up to $f$ processes under Byzantine conditions.

### Theorem 1.1 (Fischer-Lynch-Paterson Impossibility)
In an asynchronous network with even a single unannounced fail-stop crash ($f=1$), deterministic consensus is unsolvable.

$$\\text{Decide}(\\sigma) = \\bot \\iff \\forall t \\ge 0, \\; \\exists \\text{ bivalent schedule } \\mathcal{S}_t$$`,
        contentLatex: `\\chapter{Foundations of Classical Asynchronous Consensus}
\\label{ch:classical-consensus}

Consensus in distributed systems requires a set of independent processes $\\mathcal{P} = \\{p_1, p_2, \\dots, p_n\\}$ to agree upon a single state transition...`,
        ragCitations: [
          {
            id: 'c-1',
            sourceDoc: 'Lamport_1982_ByzantineGenerals.pdf',
            pageNumber: 4,
            sectionSnippet: 'A set of generals of the Byzantine army camped outside an enemy city must decide upon a common battle plan...',
            relevanceScore: 0.98,
            authorYear: 'Lamport et al., 1982',
          },
        ],
        children: [
          {
            id: 'sec-1-1',
            title: 'Formal Safety and Liveness Definitions',
            sectionNumber: '1.1',
            level: 2,
            status: 'compiled',
            targetPages: 12,
            wordBudget: 4200,
            actualWords: 4190,
            equationDensityLevel: 4,
            mathLevel: 'rigorous',
            contentMarkdown: `### 1.1 Formal Safety and Liveness Definitions

A protocol $\\Pi$ satisfies **Byzantine Consensus** if for all executions the following three properties hold:

1. **Agreement (Safety):** If correct processes $p_i$ and $p_j$ decide on values $v_i, v_j$, then $v_i = v_j$.
2. **Validity:** If all correct processes propose $v_0$, then any decided value must be $v_0$.
3. **Termination (Liveness):** Every correct process eventually decides on some value $v \\in \\mathcal{V}$.

$$\\mathbb{P}\\left[\\lim_{t \\to \\infty} \\text{Decided}(p_i, t) = v^*\\right] = 1 \\quad \\forall p_i \\in \\text{Correct}(\\mathcal{P})$$`,
            contentLatex: `\\section{Formal Safety and Liveness Definitions}
A protocol $\\Pi$ satisfies Byzantine Consensus...`,
            ragCitations: [
              {
                id: 'c-2',
                sourceDoc: 'Castro_Liskov_PBFT_TOCS.pdf',
                pageNumber: 3,
                sectionSnippet: 'Safety means that the service satisfies its state-machine specification, behaving as a centralized implementation...',
                relevanceScore: 0.94,
                authorYear: 'Castro & Liskov, 2002',
              },
            ],
          },
          {
            id: 'sec-1-2',
            title: 'Byzantine Quorum Intersection & Threshold Bounds',
            sectionNumber: '1.2',
            level: 2,
            status: 'compiled',
            targetPages: 18,
            wordBudget: 5800,
            actualWords: 5750,
            equationDensityLevel: 5,
            mathLevel: 'formal_proof',
            contentMarkdown: `### 1.2 Byzantine Quorum Intersection & Threshold Bounds

Let $n$ denote total nodes and $f$ denote the maximum number of Byzantine faulty nodes. To guarantee that any two quorums $\\mathcal{Q}_1, \\mathcal{Q}_2 \\subseteq \\mathcal{P}$ share at least one non-faulty node, we require:

$$|\\mathcal{Q}_1 \\cap \\mathcal{Q}_2| \\ge f + 1$$

Given quorum sizes $|\mathcal{Q}_i| = q$:

$$2q - n \\ge f + 1 \\implies q \\ge \\frac{n + f + 1}{2}$$

Furthermore, for resilience against $f$ silent crashes, quorums must be satisfiable by $n - f$ responses:

$$n - f \\ge q \\implies n - f \\ge \\frac{n + f + 1}{2} \\implies n \\ge 3f + 1$$

$$\\boxed{n_{\\min} = 3f + 1}$$`,
            contentLatex: `\\section{Byzantine Quorum Intersection}
\\begin{equation}
|\\mathcal{Q}_1 \\cap \\mathcal{Q}_2| \\ge f + 1 \\implies n \\ge 3f + 1
\\end{equation}`,
            ragCitations: [
              {
                id: 'c-3',
                sourceDoc: 'Castro_Liskov_PBFT_TOCS.pdf',
                pageNumber: 8,
                sectionSnippet: 'The system can tolerate up to f faulty nodes in a system with 3f+1 replicas because 2f+1 replicas intersect in at least one correct node...',
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
        sectionNumber: '2',
        level: 1,
        status: 'review_ready',
        targetPages: 55,
        wordBudget: 18000,
        actualWords: 16400,
        equationDensityLevel: 5,
        mathLevel: 'formal_proof',
        subPrompt: 'Formulate Pauli group stabilizers and quantum secret sharing schemes for distributed state validation.',
        contentMarkdown: `# Chapter 2: Quantum State Sharing & Stabilizer Codes

In contrast to classical bit replication, the **No-Cloning Theorem** prevents perfect copying of an arbitrary unknown quantum state $|\\psi\\rangle = \\alpha|0\\rangle + \\beta|1\\rangle$.

$$\\nexists \\; U_{\\text{clone}} : U_{\\text{clone}}(|\\psi\\rangle \\otimes |0\\rangle) = |\\psi\\rangle \\otimes |\\psi\\rangle \\quad \\forall |\\psi\\rangle$$

## 2.1 The Pauli Group and Stabilizer Formalism

Let $\\mathcal{G}_n$ denote the $n$-qubit Pauli group with elements $g = i^k \\sigma_1 \\otimes \\dots \\otimes \\sigma_n$ where $\\sigma_j \\in \\{I, X, Y, Z\\}$.

An $[[n, k, d]]$ stabilizer code is defined as the joint $+1$ eigenspace of an abelian subgroup $\\mathcal{S} \\subset \\mathcal{G}_n$ such that $-I \\notin \\mathcal{S}$:

$$\\mathcal{C}(\\mathcal{S}) = \\{ |\\psi\\rangle \\in \\mathbb{C}^{2^n} \\;:\\; S_i |\\psi\\rangle = +1 |\\psi\\rangle, \\; \\forall S_i \\in \\mathcal{S} \\}$$`,
        contentLatex: `\\chapter{Quantum State Sharing & Stabilizer Codes}
\\label{ch:quantum-stabilizer}
In contrast to classical bit replication, the No-Cloning Theorem prevents perfect copying...`,
        ragCitations: [
          {
            id: 'c-4',
            sourceDoc: 'Fowler_2012_SurfaceCodesQuantumComputing.pdf',
            pageNumber: 12,
            sectionSnippet: 'Stabilizer operators correspond to measurements of commuting observables on a lattice of data qubits...',
            relevanceScore: 0.96,
            authorYear: 'Fowler et al., 2012',
          },
        ],
        children: [
          {
            id: 'sec-2-1',
            title: 'Surface Code Syndrome Extraction Cycles',
            sectionNumber: '2.1',
            level: 2,
            status: 'drafting',
            targetPages: 22,
            wordBudget: 7200,
            actualWords: 6800,
            equationDensityLevel: 5,
            mathLevel: 'formal_proof',
            contentMarkdown: `### 2.1 Surface Code Syndrome Extraction Cycles

The 2D surface code on a rotated lattice of distance $d$ encodes $k=1$ logical qubit into $n = d^2 + (d-1)^2$ physical qubits.

Syndrome measurements evaluate vertex operators $A_v$ and plaquette operators $B_p$:

$$A_v = \\prod_{i \\in v} X_i, \\qquad B_p = \\prod_{j \\in p} Z_j$$

Any single physical $X$-error creates a pair of flipped $Z$-syndrome defects ($B_p = -1$) at adjacent plaquettes. Minimum-Weight Perfect Matching (MWPM) reconstructs the most probable error chain $\\mathcal{E}$ via graph distance $w_{ij} = \\text{dist}(p_i, p_j)$:

$$\\min_{\\mathcal{M}} \\sum_{(u, v) \\in \\mathcal{M}} \\ln \\left( \\frac{1 - p_{\\text{err}}}{p_{\\text{err}}} \\right) \\cdot \\text{Manhattan}(u, v)$$`,
            contentLatex: `\\section{Surface Code Syndrome Extraction}
\\begin{equation}
A_v = \\prod_{i \\in v} X_i, \\quad B_p = \\prod_{j \\in p} Z_j
\\end{equation}`,
            ragCitations: [
              {
                id: 'c-5',
                sourceDoc: 'Fowler_2012_SurfaceCodesQuantumComputing.pdf',
                pageNumber: 26,
                sectionSnippet: 'Topological error correction decodes syndromes by finding the minimum-weight matching of boundary defect pairs...',
                relevanceScore: 0.99,
                authorYear: 'Fowler et al., 2012',
              },
            ],
          },
          {
            id: 'sec-2-2',
            title: 'Quantum Byzantine Agreement (QBA) Protocols',
            sectionNumber: '2.2',
            level: 2,
            status: 'not_started',
            targetPages: 20,
            wordBudget: 6500,
            actualWords: 0,
            equationDensityLevel: 4,
            mathLevel: 'rigorous',
            contentMarkdown: `*(This section is queued for recursive generation by the Multi-Agent Drafting Pipeline.)*`,
            contentLatex: `\\section{Quantum Byzantine Agreement Protocols}
% Queued for multi-agent synthesis`,
            ragCitations: [],
          },
        ],
      },
      {
        id: 'ch-3',
        title: 'Hybrid Classical-Quantum Distributed Architectures',
        sectionNumber: '3',
        level: 1,
        status: 'not_started',
        targetPages: 60,
        wordBudget: 20000,
        actualWords: 0,
        equationDensityLevel: 4,
        mathLevel: 'applied',
        subPrompt: 'Synthesize entanglement routing with classical PBFT leader rotation.',
        contentMarkdown: `*(Chapter queued for hierarchical planning)*`,
        contentLatex: `\\chapter{Hybrid Classical-Quantum Distributed Architectures}`,
        ragCitations: [],
        children: [
          {
            id: 'sec-3-1',
            title: 'Entanglement-Swapping Mesh Networks',
            sectionNumber: '3.1',
            level: 2,
            status: 'not_started',
            targetPages: 25,
            wordBudget: 8000,
            actualWords: 0,
            equationDensityLevel: 4,
            mathLevel: 'rigorous',
            contentMarkdown: ``,
            contentLatex: ``,
            ragCitations: [],
          },
          {
            id: 'sec-3-2',
            title: 'Fault-Tolerant Leader Election via GHZ States',
            sectionNumber: '3.2',
            level: 2,
            status: 'not_started',
            targetPages: 25,
            wordBudget: 8000,
            actualWords: 0,
            equationDensityLevel: 4,
            mathLevel: 'formal_proof',
            contentMarkdown: ``,
            contentLatex: ``,
            ragCitations: [],
          },
        ],
      },
    ],
  },
  {
    id: 'book-reinforcement-learning',
    title: 'Deep Reinforcement Learning & Multi-Agent Planning',
    subtitle: 'From Policy Gradients to Game-Theoretic Multi-Agent Systems',
    authors: ['Dr. Arthur Hayes', 'Prof. Sarah Chen'],
    topic: 'Hierarchical Multi-Agent RL, Bellman Contractions, and Value Factorization',
    targetAudience: 'graduate',
    totalPagesBudget: 350,
    equationFrequencyLevel: 5,
    doConsiderOutline: true,
    doConsiderPreviousSections: true,
    outputFormat: 'latex',
    createdAt: '2026-07-19',
    updatedAt: '2026-08-20',
    sources: [
      {
        id: 'rl-1',
        name: 'Sutton_Barto_RL_2018.pdf',
        size: '12.4 MB',
        type: 'pdf',
        chunksCount: 340,
        uploadDate: '2026-07-19',
        status: 'indexed',
        authors: 'Richard S. Sutton, Andrew G. Barto',
        year: '2018',
        description: 'Reinforcement Learning: An Introduction (2nd Edition)',
      },
      {
        id: 'rl-2',
        name: 'MARL_Coordination_Architectures.docx',
        size: '1.1 MB',
        type: 'doc',
        chunksCount: 32,
        uploadDate: '2026-07-22',
        status: 'indexed',
        authors: 'Dr. Arthur Hayes',
        year: '2026',
      },
      {
        id: 'rl-3',
        name: 'DeepRL_Policy_Gradients_Lecture.pptx',
        size: '6.8 MB',
        type: 'ppt',
        chunksCount: 140,
        uploadDate: '2026-07-25',
        status: 'indexed',
        authors: 'Prof. Sarah Chen',
        year: '2026',
      },
      {
        id: 'rl-4',
        name: 'OpenAI_SpinningUp_DeepRL_Notes.md',
        size: '1.2 MB',
        type: 'md',
        chunksCount: 45,
        uploadDate: '2026-08-02',
        status: 'indexed',
        authors: 'Josh Achiam',
      },
      {
        id: 'rl-5',
        name: 'Bellman_Contractions_Benchmarks.txt',
        size: '340 KB',
        type: 'txt',
        chunksCount: 22,
        uploadDate: '2026-08-05',
        status: 'indexed',
      },
    ],
    outline: [
      {
        id: 'rl-ch-1',
        title: 'Markov Decision Processes and Dynamic Programming',
        sectionNumber: '1',
        level: 1,
        status: 'compiled',
        targetPages: 40,
        wordBudget: 13000,
        actualWords: 12900,
        equationDensityLevel: 5,
        mathLevel: 'formal_proof',
        contentMarkdown: `# Chapter 1: Markov Decision Processes and Dynamic Programming

An MDP is defined as a 5-tuple $(\\mathcal{S}, \\mathcal{A}, \\mathcal{P}, \\mathcal{R}, \\gamma)$ where $\\mathcal{S}$ is state space, $\\mathcal{A}$ action space, $\\mathcal{P}(s'|s,a)$ transition probability, $\\mathcal{R}(s,a)$ reward function, and $\\gamma \\in [0, 1)$ discount factor.

## 1.1 The Bellman Optimality Equation
The value function under the optimal policy $\\pi^*$ satisfies the fixed-point equation:

$$\\mathcal{T}^* V(s) = \\max_{a \\in \\mathcal{A}} \\left[ \\mathcal{R}(s, a) + \\gamma \\sum_{s' \\in \\mathcal{S}} \\mathcal{P}(s'|s,a) V(s') \\right]$$

### Theorem 1.1 (Banach Fixed-Point Contraction)
The Bellman optimality operator $\\mathcal{T}^*$ is a $\\gamma$-contraction in supremum norm:

$$\\|\\mathcal{T}^* U - \\mathcal{T}^* V\\|_\\infty \\le \\gamma \\|U - V\\|_\\infty$$`,
        contentLatex: `\\chapter{Markov Decision Processes}\n\\label{ch:mdp}\nAn MDP is defined as a 5-tuple $(\\mathcal{S}, \\mathcal{A}, \\mathcal{P}, \\mathcal{R}, \\gamma)$...`,
        ragCitations: [
          {
            id: 'c-rl-1',
            sourceDoc: 'Sutton_Barto_RL_2018.pdf',
            pageNumber: 58,
            sectionSnippet: 'The Bellman optimality equations are non-linear systems of equations whose unique solution is the optimal value function...',
            relevanceScore: 0.99,
            authorYear: 'Sutton & Barto, 2018',
          },
        ],
        children: [
          {
            id: 'rl-sec-1-1',
            title: 'Policy Iteration & Monotonic Improvement',
            sectionNumber: '1.1',
            level: 2,
            status: 'compiled',
            targetPages: 18,
            wordBudget: 5500,
            actualWords: 5400,
            equationDensityLevel: 5,
            mathLevel: 'formal_proof',
            contentMarkdown: `### 1.1 Policy Iteration & Monotonic Improvement

Given policy $\\pi_k$, policy improvement yields $\\pi_{k+1}(s) = \\arg\\max_a q_{\\pi_k}(s, a)$. The Policy Improvement Theorem guarantees:

$$v_{\\pi_{k+1}}(s) \\ge v_{\\pi_k}(s) \\quad \\forall s \\in \\mathcal{S}$$`,
            contentLatex: `\\section{Policy Iteration}\nGiven policy $\\pi_k$...`,
            ragCitations: [],
          },
        ],
      },
      {
        id: 'rl-ch-2',
        title: 'Multi-Agent Value Factorization & Game Theory',
        sectionNumber: '2',
        level: 1,
        status: 'drafting',
        targetPages: 50,
        wordBudget: 16000,
        actualWords: 9200,
        equationDensityLevel: 5,
        mathLevel: 'rigorous',
        contentMarkdown: `# Chapter 2: Multi-Agent Value Factorization

In cooperative multi-agent reinforcement learning (MARL), $N$ agents jointly choose action $\\mathbf{a} = (a_1, \\dots, a_N)$ to maximize team reward.

## 2.1 Individual-Global-Max (IGM) Condition
A joint action-value function $Q_{\\text{tot}}(\\mathbf{s}, \\mathbf{a})$ satisfies the IGM property if:

$$\\arg\\max_{\\mathbf{a}} Q_{\\text{tot}}(\\mathbf{s}, \\mathbf{a}) = \\begin{pmatrix} \\arg\\max_{a_1} Q_1(s_1, a_1) \\\\ \\vdots \\\\ \\arg\\max_{a_N} Q_N(s_N, a_N) \\end{pmatrix}$$`,
        contentLatex: `\\chapter{Multi-Agent Value Factorization}`,
        ragCitations: [],
      },
    ],
  },
  {
    id: 'book-geometric-deep-learning',
    title: 'Geometric Deep Learning: Grids, Groups, Graphs & Geodesics',
    subtitle: 'A Unifying Symmetry Perspective from the Erlangen Programme to Gauge Transformers',
    authors: ['Prof. Michael M. Bronstein', 'Dr. Joan Bruna', 'AutoGenBook AI Synthesis Team'],
    topic: 'Equivariant Neural Networks, Lie Groups, Sheaf Neural Networks, and Riemannian Manifolds',
    targetAudience: 'phd_researcher',
    totalPagesBudget: 480,
    equationFrequencyLevel: 5,
    doConsiderOutline: true,
    doConsiderPreviousSections: true,
    outputFormat: 'latex',
    createdAt: '2026-08-01',
    updatedAt: '2026-08-25',
    sources: [
      {
        id: 'gdl-1',
        name: 'Bronstein_2021_GeometricDeepLearning_Blueprint.pdf',
        size: '18.6 MB',
        type: 'pdf',
        chunksCount: 420,
        uploadDate: '2026-08-01',
        status: 'indexed',
        authors: 'Bronstein, Bruna, Cohen, Velickovic',
        year: '2021',
        doi: '10.48550/arXiv.2104.13478',
      },
      {
        id: 'gdl-2',
        name: 'Equivariant_Layers_Specification.docx',
        size: '920 KB',
        type: 'doc',
        chunksCount: 36,
        uploadDate: '2026-08-03',
        status: 'indexed',
        authors: 'Dr. Joan Bruna',
        year: '2025',
      },
      {
        id: 'gdl-3',
        name: 'Gauge_Equivariance_Keynote.pptx',
        size: '9.2 MB',
        type: 'ppt',
        chunksCount: 175,
        uploadDate: '2026-08-08',
        status: 'indexed',
        authors: 'Michael M. Bronstein',
        year: '2026',
      },
      {
        id: 'gdl-4',
        name: 'Cellular_Sheaf_Diffusion_Notes.md',
        size: '640 KB',
        type: 'md',
        chunksCount: 48,
        uploadDate: '2026-08-12',
        status: 'indexed',
      },
      {
        id: 'gdl-5',
        name: 'Erlangen_Programme_Symmetry_Axioms.txt',
        size: '95 KB',
        type: 'txt',
        chunksCount: 12,
        uploadDate: '2026-08-15',
        status: 'indexed',
        authors: 'Felix Klein / Annotated',
        year: '1872',
      },
    ],
    outline: [
      {
        id: 'gdl-ch-1',
        title: 'Symmetries, Groups, and Equivariant Maps',
        sectionNumber: '1',
        level: 1,
        status: 'compiled',
        targetPages: 48,
        wordBudget: 15500,
        actualWords: 15200,
        equationDensityLevel: 5,
        mathLevel: 'formal_proof',
        contentMarkdown: `# Chapter 1: Symmetries, Groups, and Equivariant Maps

Following Felix Klein's Erlangen Programme (1872), geometry is the study of invariants under transformation groups. In modern representation theory, deep neural network layers are structured as equivariant operators between vector bundles.

## 1.1 Equivariance and Invariance Definitions
Let $G$ be a Lie group acting on domain $\\Omega$ with group action $\\mathfrak{g} \\in G$, and let $\\rho_X, \\rho_Y$ be linear representations of $G$ acting on feature spaces $\\mathcal{X}(\\Omega)$ and $\\mathcal{Y}(\\Omega)$.

An operator $\\Phi: \\mathcal{X} \\to \\mathcal{Y}$ is said to be **$G$-equivariant** if:

$$\\Phi(\\rho_X(g) f) = \\rho_Y(g) \\Phi(f) \\quad \\forall g \\in G, \\; \\forall f \\in \\mathcal{X}$$

$$\\begin{matrix} \\mathcal{X} & \\xrightarrow{\\quad \\Phi \\quad} & \\mathcal{Y} \\\\ \\rho_X(g) \\Bigg\\downarrow & & \\Bigg\\downarrow \\rho_Y(g) \\\\ \\mathcal{X} & \\xrightarrow{\\quad \\Phi \\quad} & \\mathcal{Y} \\end{matrix}$$`,
        contentLatex: `\\chapter{Symmetries, Groups, and Equivariant Maps}\n\\label{ch:symmetries}\nFollowing Felix Klein's Erlangen Programme (1872)...`,
        ragCitations: [
          {
            id: 'c-gdl-1',
            sourceDoc: 'Bronstein_2021_GeometricDeepLearning_Blueprint.pdf',
            pageNumber: 14,
            sectionSnippet: 'Geometric Deep Learning is an attempt to geometrize deep learning by applying symmetry and invariance principles...',
            relevanceScore: 0.99,
            authorYear: 'Bronstein et al., 2021',
          },
        ],
        children: [
          {
            id: 'gdl-sec-1-1',
            title: 'Lie Algebra Representations & Harmonic Analysis',
            sectionNumber: '1.1',
            level: 2,
            status: 'compiled',
            targetPages: 20,
            wordBudget: 6200,
            actualWords: 6150,
            equationDensityLevel: 5,
            mathLevel: 'formal_proof',
            contentMarkdown: `### 1.1 Lie Algebra Representations & Harmonic Analysis

For compact Lie groups such as $SO(3)$ or $SU(2)$, the Peter-Weyl theorem guarantees decomposition into irreducible representations (irreps) labeled by integer or half-integer spin $l \\in \\{0, 1, 2, \\dots\\}$:

$$L^2(G) = \\bigoplus_{l=0}^\\infty (2l+1) \\mathcal{D}^l(g)$$

Wigner $D$-matrices provide the unitary representation basis for steerable spherical filters:

$$\\mathcal{D}_{m, n}^l(\\alpha, \\beta, \\gamma) = e^{-i m \\alpha} d_{m, n}^l(\\beta) e^{-i n \\gamma}$$`,
            contentLatex: `\\section{Lie Algebra Representations}`,
            ragCitations: [],
          },
        ],
      },
      {
        id: 'gdl-ch-2',
        title: 'Gauge Equivariant Mesh Convolutions and Sheaf Laplacians',
        sectionNumber: '2',
        level: 1,
        status: 'drafting',
        targetPages: 55,
        wordBudget: 17500,
        actualWords: 8400,
        equationDensityLevel: 5,
        mathLevel: 'formal_proof',
        contentMarkdown: `# Chapter 2: Gauge Equivariant Mesh Convolutions

On a non-flat Riemannian manifold $(\\mathcal{M}, g)$, there is in general no global coordinate system. Gauge equivariant networks define parallel transport between local tangent frames $T_p\\mathcal{M} \\to T_q\\mathcal{M}$.

$$\\nabla_X Y = X^i \\left( \\frac{\\partial Y^k}{\\partial x^i} + \\Gamma_{ij}^k Y^j \\right) \\frac{\\partial}{\\partial x^k}$$`,
        contentLatex: `\\chapter{Gauge Equivariant Mesh Convolutions}`,
        ragCitations: [],
      },
    ],
  },
];
