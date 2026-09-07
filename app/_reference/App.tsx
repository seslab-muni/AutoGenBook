/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { BookProject, OutlineNode, AgentStreamLog, IngestedSource } from './types';
import { SAMPLE_BOOKS } from './data/sampleBooks';
import { TopHeader } from './components/layout/TopHeader';
import { StructuredArchitectView } from './components/variants/StructuredArchitectView';
import { WelcomeProjectsView } from './components/welcome/WelcomeProjectsView';
import { NewBookWizardModal } from './components/modals/NewBookWizardModal';
import { ExportModal } from './components/modals/ExportModal';
import { ProjectSettingsModal } from './components/modals/ProjectSettingsModal';
import { SourcesExplorerModal } from './components/modals/SourcesExplorerModal';

type AppRoute = 'welcome' | 'studio';

export default function App() {
  const [books, setBooks] = useState<BookProject[]>(SAMPLE_BOOKS);
  const [currentBookId, setCurrentBookId] = useState<string>(SAMPLE_BOOKS[0]?.id || '');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('sec-1-2');
  const [viewRoute, setViewRoute] = useState<AppRoute>('welcome');

  // Modals state
  const [isNewBookModalOpen, setIsNewBookModalOpen] = useState<boolean>(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState<boolean>(false);
  const [isSourcesModalOpen, setIsSourcesModalOpen] = useState<boolean>(false);

  // Closeable Panes State
  const [isOutlineOpen, setIsOutlineOpen] = useState<boolean>(true);
  const [isAgentOpen, setIsAgentOpen] = useState<boolean>(true);

  // Initialize Route from window.location.pathname
  useEffect(() => {
    const handleLocation = () => {
      const path = window.location.pathname;
      if (path.startsWith('/p/')) {
        const idFromPath = path.replace(/^\/p\//, '').split('/')[0] || '';
        if (idFromPath) {
          const match = books.find((b) => b.id === idFromPath);
          if (match) {
            setCurrentBookId(match.id);
            if (match.outline.length > 0) {
              const firstNode = match.outline[0]!;
              setSelectedNodeId(firstNode.children?.[0]?.id || firstNode.id);
            }
          } else {
            setCurrentBookId(idFromPath);
          }
          setViewRoute('studio');
          return;
        }
      }
      setViewRoute('welcome');
    };

    handleLocation();
    window.addEventListener('popstate', handleLocation);
    return () => window.removeEventListener('popstate', handleLocation);
  }, [books]);

  // Navigation handlers
  const navigateToProject = (projectId: string) => {
    const targetBook = books.find((b) => b.id === projectId);
    window.history.pushState({}, '', `/p/${projectId}`);
    setCurrentBookId(projectId);
    if (targetBook && targetBook.outline.length > 0) {
      const firstNode = targetBook.outline[0]!;
      setSelectedNodeId(firstNode.children?.[0]?.id || firstNode.id);
    }
    setViewRoute('studio');
  };

  const navigateToHome = () => {
    window.history.pushState({}, '', '/');
    setViewRoute('welcome');
  };

  // Streaming & Agent Logs State
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [tokenBuffer, setTokenBuffer] = useState<string>('');
  const [thoughtTrace, setThoughtTrace] = useState<string[]>([
    'Top-Down Planner initialized: verified chapter 1 and chapter 2 bounds against page budget.',
    'RAG Retriever: embedded references and retrieved relevant semantic chunks.',
    'Math Formalizer: verified theorem lemmas and LaTeX derivations.',
  ]);
  const [logs, setLogs] = useState<AgentStreamLog[]>([
    {
      id: 'log-1',
      timestamp: '06:14:02',
      agentName: 'Planner Agent',
      agentColor: '#6366f1',
      status: 'completed',
      thought: 'Decomposed outline tree into hierarchical tiers with balanced leaf page budgets.',
      currentStep: 'Outline Partitioning',
    },
    {
      id: 'log-2',
      timestamp: '06:15:40',
      agentName: 'RAG Retriever',
      agentColor: '#38bdf8',
      status: 'completed',
      thought: 'Embedded reference sources and extracted vector chunks with high cosine similarity.',
      currentStep: 'Vector Retrieval',
    },
    {
      id: 'log-3',
      timestamp: '06:17:11',
      agentName: 'Writer Agent',
      agentColor: '#10b981',
      status: 'completed',
      thought: 'Synthesized theoretical bounds with formal LaTeX proof equations.',
      currentStep: 'Section Synthesis',
    },
  ]);

  const currentBook = useMemo(() => {
    return books.find((b) => b.id === currentBookId) || books[0]!;
  }, [books, currentBookId]);

  // Helper to find node in tree recursively
  const findNode = (nodes: OutlineNode[], id: string): OutlineNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children && node.children.length > 0) {
        const found = findNode(node.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  const selectedNode = useMemo(() => {
    return findNode(currentBook.outline, selectedNodeId) || currentBook.outline[0] || null;
  }, [currentBook, selectedNodeId]);

  // Total words across book
  const totalWords = useMemo(() => {
    let words = 0;
    const countWords = (list: OutlineNode[]) => {
      list.forEach((n) => {
        words += (n.contentMarkdown || '').split(/\s+/).filter(Boolean).length;
        if (n.children && n.children.length > 0) countWords(n.children);
      });
    };
    countWords(currentBook.outline);
    return words;
  }, [currentBook]);

  // Add child or root chapter node (enforcing configurable max levels, default 3)
  const handleAddChildNode = (parentNodeId: string) => {
    const maxLevels = currentBook.maxOutlineLevels ?? 3;
    const newNodeId = `node-${Date.now()}`;
    const targetParent = parentNodeId === 'root' ? null : findNode(currentBook.outline, parentNodeId);
    const parentLevel = targetParent ? targetParent.level : 0;
    
    // Cap depth at maxLevels
    if (parentLevel >= maxLevels) return;

    const newSection: OutlineNode = {
      id: newNodeId,
      title: 'New Synthesized Section',
      sectionNumber: parentNodeId === 'root' ? `${currentBook.outline.length + 1}` : `${targetParent?.sectionNumber}.${(targetParent?.children || []).length + 1}`,
      level: (parentLevel + 1),
      status: 'not_started',
      targetPages: 12,
      wordBudget: 4200,
      actualWords: 0,
      equationDensityLevel: currentBook.equationFrequencyLevel,
      mathLevel: 'rigorous',
      subPrompt: 'Develop formal lemma with LaTeX mathematical derivations.',
      contentMarkdown: `### New Section\n\n*(Ready for multi-agent synthesis. Click "Draft Section" or "Expand Proofs" in the AI Copilot pane.)*`,
      contentLatex: `\\section{New Section}`,
      ragCitations: [],
    };

    const updateTree = (nodes: OutlineNode[]): OutlineNode[] => {
      if (parentNodeId === 'root') {
        return [...nodes, newSection];
      }
      return nodes.map((node) => {
        if (node.id === parentNodeId) {
          return {
            ...node,
            children: [...(node.children || []), newSection],
          };
        }
        if (node.children) {
          return { ...node, children: updateTree(node.children) };
        }
        return node;
      });
    };

    const updatedOutline = updateTree(currentBook.outline);
    setBooks(
      books.map((b) => (b.id === currentBook.id ? { ...b, outline: updatedOutline } : b))
    );
    setSelectedNodeId(newNodeId);
  };

  // Rename node
  const handleRenameNode = (nodeId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    const updateTree = (nodes: OutlineNode[]): OutlineNode[] => {
      return nodes.map((node) => {
        if (node.id === nodeId) {
          return { ...node, title: trimmed };
        }
        if (node.children) {
          return { ...node, children: updateTree(node.children) };
        }
        return node;
      });
    };

    setBooks(
      books.map((b) => (b.id === currentBook.id ? { ...b, outline: updateTree(b.outline) } : b))
    );
  };

  // Delete node
  const handleDeleteNode = (nodeId: string) => {
    const filterTree = (nodes: OutlineNode[]): OutlineNode[] => {
      return nodes
        .filter((n) => n.id !== nodeId)
        .map((n) => (n.children ? { ...n, children: filterTree(n.children) } : n));
    };

    const updatedOutline = filterTree(currentBook.outline);
    setBooks(
      books.map((b) => (b.id === currentBook.id ? { ...b, outline: updatedOutline } : b))
    );
    if (selectedNodeId === nodeId && updatedOutline.length > 0) {
      setSelectedNodeId(updatedOutline[0]!.id);
    }
  };

  // Update content of node
  const handleUpdateContent = (nodeId: string, markdown: string, latex?: string) => {
    const updateTree = (nodes: OutlineNode[]): OutlineNode[] => {
      return nodes.map((node) => {
        if (node.id === nodeId) {
          const words = markdown.trim().split(/\s+/).filter(Boolean).length;
          return {
            ...node,
            contentMarkdown: markdown,
            contentLatex: latex || node.contentLatex,
            actualWords: words,
            status: words > 100 ? 'review_ready' : node.status,
          };
        }
        if (node.children) {
          return { ...node, children: updateTree(node.children) };
        }
        return node;
      });
    };

    setBooks(
      books.map((b) => (b.id === currentBook.id ? { ...b, outline: updateTree(b.outline) } : b))
    );
  };

  // Trigger agent streaming simulation
  const handleTriggerNodeGeneration = (promptModifier?: string) => {
    if (isStreaming) return;
    setIsStreaming(true);
    setTokenBuffer('');

    const targetNode = selectedNode || currentBook.outline[0]!;

    // Step 1: Planner
    const timestamp1 = new Date().toTimeString().split(' ')[0]!;
    const logPlanner: AgentStreamLog = {
      id: `log-${Date.now()}-1`,
      timestamp: timestamp1,
      agentName: 'Planner Agent',
      agentColor: '#6366f1',
      status: 'active',
      thought: `Allocating semantic structure for §${targetNode.sectionNumber} based on ${targetNode.mathLevel} rigor.`,
      currentStep: 'Decomposition',
    };
    setLogs((prev) => [logPlanner, ...prev]);

    // Simulated streaming tokens
    const sampleStream = `\n\n> **Theorem ${targetNode.sectionNumber}.1 (Asynchronous Agreement Bound)**: Let $\\mathcal{N} = \\{1, \\dots, n\\}$ denote $n$ independent distributed state replicas under an adversarial scheduler. If up to $f$ processes exhibit arbitrary Byzantine faulty transitions, consensus is attainable if and only if:\n\n$$n \\ge 3f + 1$$\n\n*Proof.* Consider two intersecting quorums $Q_1, Q_2 \\subset \\mathcal{N}$ with $|Q_1| = |Q_2| = n - f$. The intersection size satisfies:\n\n$$|Q_1 \\cap Q_2| = |Q_1| + |Q_2| - |Q_1 \\cup Q_2| \\ge 2(n - f) - n = n - 2f$$\n\nTo ensure at least one correct non-faulty replica lies in the intersection:\n\n$$n - 2f \\ge f + 1 \\implies n \\ge 3f + 1 \\quad \\blacksquare$$\n\n### Practical Implementation Considerations\nIn modern asynchronous Byzantine Fault Tolerant (aBFT) deployments, this fundamental resilience threshold is realized through verifiable random beacon consensus.`;

    let currentIndex = 0;
    const interval = setInterval(() => {
      if (currentIndex < sampleStream.length) {
        setTokenBuffer((prev) => prev + sampleStream.slice(currentIndex, currentIndex + 8));
        currentIndex += 8;
      } else {
        clearInterval(interval);
        setIsStreaming(false);

        // Update node content with new stream
        const newMarkdown = (targetNode.contentMarkdown || '') + sampleStream;
        handleUpdateContent(targetNode.id, newMarkdown);

        // Update logs
        const logWriter: AgentStreamLog = {
          id: `log-${Date.now()}-2`,
          timestamp: new Date().toTimeString().split(' ')[0]!,
          agentName: 'Writer Agent',
          agentColor: '#10b981',
          status: 'completed',
          thought: `Successfully synthesized theorem proof and quorum intersection bounds into §${targetNode.sectionNumber}.`,
          currentStep: 'Synthesis Finished',
        };
        setLogs((prev) => [logWriter, ...prev]);

        // Add to thought trace
        setThoughtTrace((prev) => [
          `Recursive formalizer completed proof synthesis for §${targetNode.sectionNumber} with rigor level: ${targetNode.mathLevel}.`,
          ...prev,
        ]);
      }
    }, 45);
  };

  // Math Level Update
  const handleUpdateNodeMathLevel = (mathLevel: OutlineNode['mathLevel']) => {
    if (!selectedNode) return;
    const updateTree = (nodes: OutlineNode[]): OutlineNode[] => {
      return nodes.map((node) => {
        if (node.id === selectedNode.id) {
          return { ...node, mathLevel };
        }
        if (node.children) {
          return { ...node, children: updateTree(node.children) };
        }
        return node;
      });
    };
    setBooks(books.map((b) => (b.id === currentBook.id ? { ...b, outline: updateTree(b.outline) } : b)));
  };

  // Equation Density Update
  const handleUpdateNodeEquationDensity = (density: number) => {
    if (!selectedNode) return;
    const updateTree = (nodes: OutlineNode[]): OutlineNode[] => {
      return nodes.map((node) => {
        if (node.id === selectedNode.id) {
          return { ...node, equationDensityLevel: density };
        }
        if (node.children) {
          return { ...node, children: updateTree(node.children) };
        }
        return node;
      });
    };
    setBooks(books.map((b) => (b.id === currentBook.id ? { ...b, outline: updateTree(b.outline) } : b)));
  };

  // Budget Update (Pages & Words)
  const handleUpdateNodeBudget = (targetPages: number, wordBudget: number) => {
    if (!selectedNode) return;
    const updateTree = (nodes: OutlineNode[]): OutlineNode[] => {
      return nodes.map((node) => {
        if (node.id === selectedNode.id) {
          return { ...node, targetPages, wordBudget };
        }
        if (node.children) {
          return { ...node, children: updateTree(node.children) };
        }
        return node;
      });
    };
    setBooks(books.map((b) => (b.id === currentBook.id ? { ...b, outline: updateTree(b.outline) } : b)));
  };

  // Create New Book
  const handleCreateNewBook = (newBook: BookProject) => {
    setBooks([newBook, ...books]);
    setIsNewBookModalOpen(false);
    navigateToProject(newBook.id);
  };

  // Duplicate Project
  const handleDuplicateProject = (book: BookProject) => {
    const dupId = `book-${Date.now().toString().slice(-6)}`;
    const duplicated: BookProject = {
      ...book,
      id: dupId,
      title: `${book.title} (Copy)`,
      createdAt: new Date().toISOString().split('T')[0]!,
      updatedAt: new Date().toISOString().split('T')[0]!,
    };
    setBooks([duplicated, ...books]);
  };

  // Delete Project
  const handleDeleteProject = (bookId: string) => {
    const updated = books.filter((b) => b.id !== bookId);
    if (updated.length > 0) {
      setBooks(updated);
      if (currentBookId === bookId) {
        setCurrentBookId(updated[0]!.id);
      }
    }
  };

  // Save Project Settings
  const handleSaveProjectSettings = (updated: Partial<BookProject>) => {
    setBooks(
      books.map((b) => (b.id === currentBook.id ? { ...b, ...updated } : b))
    );
  };

  // Source Management
  const handleAddSource = (newSource: IngestedSource) => {
    setBooks(
      books.map((b) =>
        b.id === currentBook.id
          ? { ...b, sources: [newSource, ...b.sources], updatedAt: new Date().toISOString().split('T')[0]! }
          : b
      )
    );
  };

  const handleDeleteSource = (sourceId: string) => {
    setBooks(
      books.map((b) =>
        b.id === currentBook.id
          ? { ...b, sources: b.sources.filter((s) => s.id !== sourceId) }
          : b
      )
    );
  };

  // If on Welcome view route, display WelcomeProjectsView
  if (viewRoute === 'welcome') {
    return (
      <div className="h-full w-full overflow-y-auto bg-[#F8FAFC]">
        <WelcomeProjectsView
          books={books}
          onSelectProject={navigateToProject}
          onOpenNewModal={() => setIsNewBookModalOpen(true)}
          onDeleteProject={handleDeleteProject}
          onDuplicateProject={handleDuplicateProject}
        />

        <NewBookWizardModal
          isOpen={isNewBookModalOpen}
          onClose={() => setIsNewBookModalOpen(false)}
          onCreateBook={handleCreateNewBook}
        />
      </div>
    );
  }

  // Otherwise, display Studio Route (/p/<uuid>)
  return (
    <div className="h-full w-full overflow-hidden bg-[#F8FAFC] text-slate-900 flex flex-col font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Top Navigation & Metrics Bar */}
      <TopHeader
        currentBook={currentBook}
        books={books}
        onSelectBook={navigateToProject}
        onNavigateHome={navigateToHome}
        onOpenSourcesModal={() => setIsSourcesModalOpen(true)}
        onOpenNewModal={() => setIsNewBookModalOpen(true)}
        onOpenExportModal={() => setIsExportModalOpen(true)}
        onOpenSettingsModal={() => setIsSettingsModalOpen(true)}
        onStartBatchGeneration={() => handleTriggerNodeGeneration('Batch synthesize all draft chapters')}
        isStreaming={isStreaming}
        totalWords={totalWords}
      />

      {/* Main IDE 3-Pane Workspace with Closeable Side Panels */}
      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        <StructuredArchitectView
          nodes={currentBook.outline}
          selectedNode={selectedNode}
          onSelectNode={(node) => setSelectedNodeId(node.id)}
          onAddChildNode={handleAddChildNode}
          onDeleteNode={handleDeleteNode}
          onRenameNode={handleRenameNode}
          onGenerateNode={(node) => {
            setSelectedNodeId(node.id);
            handleTriggerNodeGeneration();
          }}
          onUpdateContent={handleUpdateContent}
          onTriggerNodeGeneration={handleTriggerNodeGeneration}
          onUpdateNodeMathLevel={handleUpdateNodeMathLevel}
          onUpdateNodeEquationDensity={handleUpdateNodeEquationDensity}
          onUpdateNodeBudget={handleUpdateNodeBudget}
          isStreaming={isStreaming}
          logs={logs}
          tokenBuffer={tokenBuffer}
          thoughtTrace={thoughtTrace}
          maxLevels={currentBook.maxOutlineLevels ?? 3}
          isOutlineOpen={isOutlineOpen}
          onToggleOutline={() => setIsOutlineOpen(!isOutlineOpen)}
          isAgentOpen={isAgentOpen}
          onToggleAgent={() => setIsAgentOpen(!isAgentOpen)}
        />
      </main>

      {/* Modals */}
      <SourcesExplorerModal
        isOpen={isSourcesModalOpen}
        onClose={() => setIsSourcesModalOpen(false)}
        currentBook={currentBook}
        onAddSource={handleAddSource}
        onDeleteSource={handleDeleteSource}
      />

      <NewBookWizardModal
        isOpen={isNewBookModalOpen}
        onClose={() => setIsNewBookModalOpen(false)}
        onCreateBook={handleCreateNewBook}
      />

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        book={currentBook}
      />

      <ProjectSettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        currentBook={currentBook}
        onSaveSettings={handleSaveProjectSettings}
      />
    </div>
  );
}
