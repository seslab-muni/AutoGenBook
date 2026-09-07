import React, { useState } from 'react';
import { OutlineNode, AgentStreamLog } from '../../types';
import { MathRenderer } from '../../utils/mathRenderer';
import { 
  BookText, 
  Terminal, 
  ChevronLeft, 
  ChevronRight, 
  Sparkles, 
  Sigma, 
  BookOpen, 
  Layers, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Play,
  Cpu,
  Minimize2,
  Maximize2
} from 'lucide-react';

interface ManuscriptPressViewProps {
  nodes: OutlineNode[];
  selectedNode: OutlineNode | null;
  onSelectNode: (node: OutlineNode) => void;
  onAddChildNode: (parentNodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onGenerateNode: (node: OutlineNode) => void;
  onUpdateContent: (nodeId: string, markdown: string) => void;
  onTriggerNodeGeneration: (promptModifier?: string) => void;
  onUpdateNodeMathLevel: (mathLevel: OutlineNode['mathLevel']) => void;
  onUpdateNodeEquationDensity: (density: number) => void;
  isStreaming: boolean;
  logs: AgentStreamLog[];
  tokenBuffer: string;
  thoughtTrace: string[];
}

export const ManuscriptPressView: React.FC<ManuscriptPressViewProps> = ({
  nodes,
  selectedNode,
  onSelectNode,
  onGenerateNode,
  onTriggerNodeGeneration,
  isStreaming,
  logs,
  tokenBuffer,
  thoughtTrace,
}) => {
  const [fontFamily, setFontFamily] = useState<'stix' | 'crimson' | 'sans'>('crimson');
  const [terminalExpanded, setTerminalExpanded] = useState<boolean>(true);

  // Flatten nodes for pagination
  const flatNodes: OutlineNode[] = [];
  const collect = (list: OutlineNode[]) => {
    list.forEach((n) => {
      flatNodes.push(n);
      if (n.children && n.children.length > 0) collect(n.children);
    });
  };
  collect(nodes);

  const currentIndex = selectedNode ? flatNodes.findIndex((n) => n.id === selectedNode.id) : 0;
  const activeNode = selectedNode || flatNodes[0];

  const handlePrev = () => {
    if (currentIndex > 0 && flatNodes[currentIndex - 1]) {
      onSelectNode(flatNodes[currentIndex - 1]);
    }
  };

  const handleNext = () => {
    if (currentIndex < flatNodes.length - 1 && flatNodes[currentIndex + 1]) {
      onSelectNode(flatNodes[currentIndex + 1]);
    }
  };

  const wordCount = activeNode ? (activeNode.contentMarkdown || '').trim().split(/\s+/).filter(Boolean).length : 0;
  const pageEstimate = Math.max(1, Math.round(wordCount / 320));

  // Split content into Left Page (theory/definitions) and Right Page (derivations/proofs/citations)
  const fullContent = activeNode?.contentMarkdown || 'No content written yet.';
  const paragraphs = fullContent.split('\n\n');
  const midPoint = Math.max(1, Math.ceil(paragraphs.length / 2));
  const leftContent = paragraphs.slice(0, midPoint).join('\n\n');
  const rightContent = paragraphs.slice(midPoint).join('\n\n') || leftContent;

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-[calc(100vh-136px)] bg-[#F8FAFC]">
      {/* Top Typesetting Ribbon */}
      <div className="h-11 px-4 bg-white border-b border-slate-200 flex items-center justify-between gap-3 text-xs">
        {/* Pagination Jump */}
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrev}
            disabled={currentIndex <= 0}
            className="p-1 rounded-md bg-slate-100 hover:bg-slate-200 disabled:opacity-30 text-slate-700 transition-colors border border-slate-200"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-mono font-medium text-slate-600">
            Folio {currentIndex + 1} of {flatNodes.length}
          </span>
          <button
            onClick={handleNext}
            disabled={currentIndex >= flatNodes.length - 1}
            className="p-1 rounded-md bg-slate-100 hover:bg-slate-200 disabled:opacity-30 text-slate-700 transition-colors border border-slate-200"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Quick Outline Dropdown Jump */}
        <div className="flex items-center gap-2">
          <span className="text-slate-500 font-mono text-[11px] font-medium">Jump to:</span>
          <select
            value={activeNode?.id}
            onChange={(e) => {
              const target = flatNodes.find((n) => n.id === e.target.value);
              if (target) onSelectNode(target);
            }}
            className="bg-[#F8FAFC] border border-slate-200 text-slate-800 px-2.5 py-1 rounded-lg text-xs font-medium focus:outline-none cursor-pointer"
          >
            {flatNodes.map((n) => (
              <option key={n.id} value={n.id}>
                §{n.sectionNumber} {n.title}
              </option>
            ))}
          </select>
        </div>

        {/* Font Family Switcher */}
        <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
          <button
            onClick={() => setFontFamily('crimson')}
            className={`px-2 py-0.5 rounded-md font-serif text-xs font-semibold transition-all ${
              fontFamily === 'crimson' ? 'bg-white text-indigo-600 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Crimson Pro
          </button>
          <button
            onClick={() => setFontFamily('stix')}
            className={`px-2 py-0.5 rounded-md font-serif text-xs font-semibold transition-all ${
              fontFamily === 'stix' ? 'bg-white text-indigo-600 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            STIX Two
          </button>
          <button
            onClick={() => setFontFamily('sans')}
            className={`px-2 py-0.5 rounded-md font-sans text-xs font-semibold transition-all ${
              fontFamily === 'sans' ? 'bg-white text-indigo-600 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Jakarta
          </button>
        </div>

        {/* Synthesis Action */}
        <button
          disabled={isStreaming}
          onClick={() => activeNode && onGenerateNode(activeNode)}
          className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg flex items-center gap-1.5 shadow-xs transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Typeset & Synthesize</span>
        </button>
      </div>

      {/* Main Center Stage: Dual-Page Manuscript Book Spread */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-[#F8FAFC] custom-scrollbar">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {/* Left Page (Recto / Verso Spread) */}
          <div
            className={`bg-white text-slate-900 rounded-2xl p-6 md:p-10 shadow-sm border border-slate-200 min-h-[620px] flex flex-col justify-between ${
              fontFamily === 'crimson'
                ? 'font-serif'
                : fontFamily === 'stix'
                ? 'font-serif tracking-tight'
                : 'font-sans'
            }`}
          >
            <div>
              {/* Header Running Head */}
              <div className="flex justify-between items-center text-[10px] uppercase tracking-widest text-slate-400 pb-3 border-b border-slate-200 mb-6 font-semibold">
                <span>Distributed Consensus & Quantum Fault Tolerance</span>
                <span className="font-mono text-slate-400">Chapter {activeNode?.sectionNumber.split('.')[0] || '1'}</span>
              </div>

              {/* Title & Section Number */}
              <div className="mb-6">
                <span className="text-[11px] font-mono font-bold text-indigo-600 tracking-wider">
                  SECTION {activeNode?.sectionNumber}
                </span>
                <h2 className="text-xl md:text-2xl font-bold text-slate-900 mt-1 tracking-tight">
                  {activeNode?.title}
                </h2>
              </div>

              {/* Text / Math Content */}
              <div className="text-slate-800 text-xs md:text-sm leading-relaxed space-y-3 text-justify">
                <MathRenderer content={leftContent} className="text-slate-900" />
              </div>
            </div>

            {/* Left Page Footer */}
            <div className="pt-4 mt-6 border-t border-slate-200 flex justify-between items-center text-[10px] text-slate-400 font-medium">
              <span className="font-mono">{currentIndex * 2 + 1}</span>
              <span>AutoGenBook Press • Cambridge Series</span>
            </div>
          </div>

          {/* Right Page (Facing Page Spread) */}
          <div
            className={`bg-white text-slate-900 rounded-2xl p-6 md:p-10 shadow-sm border border-slate-200 min-h-[620px] flex flex-col justify-between ${
              fontFamily === 'crimson'
                ? 'font-serif'
                : fontFamily === 'stix'
                ? 'font-serif tracking-tight'
                : 'font-sans'
            }`}
          >
            <div>
              {/* Header Running Head */}
              <div className="flex justify-between items-center text-[10px] uppercase tracking-widest text-slate-400 pb-3 border-b border-slate-200 mb-6 font-semibold">
                <span className="truncate max-w-[280px]">{activeNode?.title}</span>
                <span className="font-mono text-slate-400">§{activeNode?.sectionNumber}</span>
              </div>

              {/* Continuation & Formal Math */}
              <div className="text-slate-800 text-xs md:text-sm leading-relaxed space-y-3 text-justify">
                <MathRenderer content={rightContent} className="text-slate-900" />
              </div>

              {/* Academic Margin Citations Callout */}
              {activeNode && activeNode.ragCitations.length > 0 && (
                <div className="mt-6 p-3.5 bg-indigo-50/60 rounded-xl border border-indigo-100 text-[11px] text-slate-700">
                  <div className="font-bold text-indigo-950 mb-1 flex items-center gap-1">
                    <BookOpen className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Marginalia & Primary Scholarly Citations:</span>
                  </div>
                  <ul className="space-y-1 italic">
                    {activeNode.ragCitations.map((c) => (
                      <li key={c.id}>
                        • <strong>{c.authorYear || c.sourceDoc}</strong>: "{c.sectionSnippet.slice(0, 100)}..."
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Right Page Footer */}
            <div className="pt-4 mt-6 border-t border-slate-200 flex justify-between items-center text-[10px] text-slate-400 font-medium">
              <span>Equation Density: {activeNode?.equationDensityLevel}/5</span>
              <span className="font-mono">{currentIndex * 2 + 2}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Multi-Agent Execution Telemetry Terminal */}
      <div className="bg-white border-t border-slate-200 flex flex-col shadow-xs">
        <div
          onClick={() => setTerminalExpanded(!terminalExpanded)}
          className="h-8 px-4 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between cursor-pointer text-xs font-bold text-slate-700"
        >
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-indigo-600" />
            <span>AutoGen Multi-Agent Telemetry Console</span>
            {isStreaming && (
              <span className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 text-[10px] font-mono font-bold animate-pulse border border-indigo-200">
                Streaming Tokens (SSE)
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-slate-500 font-mono text-[11px]">
            <span>{logs.length} Trace Logs</span>
            <span>{terminalExpanded ? <Minimize2 className="w-3.5 h-3.5 text-slate-500" /> : <Maximize2 className="w-3.5 h-3.5 text-slate-500" />}</span>
          </div>
        </div>

        {terminalExpanded && (
          <div className="p-3.5 grid grid-cols-1 md:grid-cols-3 gap-3.5 max-h-44 overflow-y-auto bg-white font-mono text-xs text-slate-700">
            {/* Live Token Delta Buffer */}
            <div className="p-2.5 rounded-lg bg-[#F8FAFC] border border-slate-200 overflow-hidden shadow-2xs">
              <div className="text-[10px] font-bold text-indigo-600 uppercase mb-1">
                Active Token Stream
              </div>
              <div className="text-[11px] text-slate-800 h-24 overflow-y-auto leading-relaxed">
                {tokenBuffer || '(Waiting for next agent execution burst...)'}
              </div>
            </div>

            {/* Thought Reasoning Traces */}
            <div className="p-2.5 rounded-lg bg-[#F8FAFC] border border-slate-200 overflow-hidden shadow-2xs">
              <div className="text-[10px] font-bold text-amber-600 uppercase mb-1">
                Chain of Thought
              </div>
              <div className="text-[11px] text-slate-700 h-24 overflow-y-auto space-y-1">
                {thoughtTrace.map((t, i) => (
                  <div key={i} className="text-slate-600">
                    <strong className="text-indigo-600">&gt;</strong> {t}
                  </div>
                ))}
              </div>
            </div>

            {/* Pipeline Stage Indicators */}
            <div className="p-2.5 rounded-lg bg-[#F8FAFC] border border-slate-200 overflow-hidden shadow-2xs">
              <div className="text-[10px] font-bold text-emerald-600 uppercase mb-1">
                Multi-Agent Status
              </div>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-slate-500 font-medium">Top-Down Planner:</span>
                  <span className="text-emerald-600 font-bold">Ready</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-medium">Section Writer:</span>
                  <span className={isStreaming ? 'text-indigo-600 font-bold animate-pulse' : 'text-slate-700'}>
                    {isStreaming ? 'Generating...' : 'Idle'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-medium">Math Proof Checker:</span>
                  <span className="text-slate-500">Standing by</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
