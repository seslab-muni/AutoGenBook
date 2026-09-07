import React, { useState, useEffect } from 'react';
import { OutlineNode } from '../../types';
import { MathRenderer } from '../../utils/mathRenderer';
import { 
  Code2, 
  FileText, 
  Copy, 
  Check, 
  BookOpen,
  PanelLeft,
  PanelRight
} from 'lucide-react';

interface StageEditorProps {
  nodes?: OutlineNode[];
  selectedNode: OutlineNode | null;
  onSelectNode?: (node: OutlineNode) => void;
  onUpdateContent: (nodeId: string, markdown: string, latex?: string) => void;
  onTriggerContextualPrompt: (prompt: string) => void;
  isStreaming: boolean;
  isOutlineOpen?: boolean;
  onToggleOutline?: () => void;
  isAgentOpen?: boolean;
  onToggleAgent?: () => void;
}

export const StageEditor: React.FC<StageEditorProps> = ({
  nodes = [],
  selectedNode,
  onSelectNode,
  onUpdateContent,
  onTriggerContextualPrompt,
  isStreaming,
  isOutlineOpen = true,
  onToggleOutline,
  isAgentOpen = true,
  onToggleAgent,
}) => {
  const [activeTab, setActiveTab] = useState<'code' | 'pdf'>('pdf');
  const [localText, setLocalText] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [isSavedRecently, setIsSavedRecently] = useState<boolean>(false);

  // Flatten tree for chapter selection dropdown
  const flatNodes = React.useMemo(() => {
    const list: OutlineNode[] = [];
    const traverse = (items: OutlineNode[]) => {
      for (const item of items) {
        list.push(item);
        if (item.children && item.children.length > 0) {
          traverse(item.children);
        }
      }
    };
    if (nodes && nodes.length > 0) {
      traverse(nodes);
    }
    return list;
  }, [nodes]);

  useEffect(() => {
    if (selectedNode) {
      setLocalText(selectedNode.contentMarkdown || '');
    }
  }, [selectedNode?.id, selectedNode?.contentMarkdown]);

  if (!selectedNode) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-500 bg-[#F8FAFC]">
        {/* Left/Right restore toggles if closed */}
        <div className="absolute top-3 left-3 flex items-center gap-2">
          {!isOutlineOpen && onToggleOutline && (
            <button
              onClick={onToggleOutline}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg border border-slate-200 shadow-2xs"
            >
              <PanelLeft className="w-3.5 h-3.5 text-indigo-600" />
              <span>Show Outline</span>
            </button>
          )}
        </div>

        <div className="absolute top-3 right-3 flex items-center gap-2">
          {!isAgentOpen && onToggleAgent && (
            <button
              onClick={onToggleAgent}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg border border-slate-200 shadow-2xs"
            >
              <PanelRight className="w-3.5 h-3.5 text-indigo-600" />
              <span>Show Copilot</span>
            </button>
          )}
        </div>

        <BookOpen className="w-12 h-12 text-slate-400 mb-3" />
        <h3 className="text-base font-semibold text-slate-800 mb-1">No Section Selected</h3>
        <p className="text-xs text-slate-500 max-w-sm">
          Select a chapter or section from the outline tree to inspect and write.
        </p>
      </div>
    );
  }

  const wordCount = localText.trim().split(/\s+/).filter(Boolean).length;
  const pageEstimate = Math.max(1, Math.round(wordCount / 320));
  const equationMatches = localText.match(/\$[^$]+\$|\$\$[\s\S]*?\$\$/g) || [];

  const handleCopy = () => {
    navigator.clipboard.writeText(localText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveText = (newText: string) => {
    setLocalText(newText);
    onUpdateContent(selectedNode.id, newText);
    setIsSavedRecently(true);
    setTimeout(() => setIsSavedRecently(false), 1500);
  };

  return (
    <div className="h-full flex flex-col bg-[#F8FAFC] min-h-0 overflow-hidden">
      {/* Stage Editor Top Bar */}
      <div className="h-11 bg-white border-b border-slate-200 px-4 md:px-6 flex items-center justify-between gap-3 flex-shrink-0">
        {/* Left: Outline restore button (when outline is closed) + View Mode Dropdown + Chapter Selection Dropdown */}
        <div className="flex items-center gap-2 min-w-0">
          {!isOutlineOpen && onToggleOutline && (
            <button
              onClick={onToggleOutline}
              title="Show Outline Tree"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-300/80 shadow-2xs transition-all hover:border-indigo-300 flex-shrink-0"
            >
              <PanelLeft className="w-3.5 h-3.5 text-indigo-600" />
              <span className="hidden sm:inline">Outline</span>
            </button>
          )}

          {/* View Mode Dropdown (Source & PDF) */}
          <div className="relative flex items-center flex-shrink-0">
            <select
              value={activeTab}
              onChange={(e) => setActiveTab(e.target.value as 'code' | 'pdf')}
              className="appearance-none bg-white hover:bg-slate-50 border border-slate-300/80 text-slate-800 text-xs font-semibold pl-8 pr-7 py-1 rounded-lg cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs transition-all"
            >
              <option value="pdf">PDF</option>
              <option value="code">Source</option>
            </select>
            <div className="absolute left-2.5 pointer-events-none text-indigo-600">
              {activeTab === 'code' && <Code2 className="w-3.5 h-3.5" />}
              {activeTab === 'pdf' && <FileText className="w-3.5 h-3.5" />}
            </div>
            <div className="absolute right-2 pointer-events-none text-slate-400">
              <span className="text-[10px]">▼</span>
            </div>
          </div>

          {/* Chapter/Section Selection Dropdown - Visible ONLY when Outline Pane is Closed */}
          {!isOutlineOpen && flatNodes.length > 0 && onSelectNode && (
            <div className="relative flex items-center min-w-0 max-w-[200px] sm:max-w-[260px] md:max-w-[320px]">
              <select
                value={selectedNode.id}
                onChange={(e) => {
                  const target = flatNodes.find((n) => n.id === e.target.value);
                  if (target) onSelectNode(target);
                }}
                title="Switch Selected Chapter / Section"
                className="appearance-none w-full bg-white hover:bg-slate-50 border border-slate-300/80 text-slate-800 text-xs font-bold pl-2.5 pr-7 py-1 rounded-lg cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs transition-all truncate"
              >
                {flatNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {'\u00A0'.repeat((n.level - 1) * 3)}§{n.sectionNumber} {n.title}
                  </option>
                ))}
              </select>
              <div className="absolute right-2 pointer-events-none text-slate-400">
                <span className="text-[10px]">▼</span>
              </div>
            </div>
          )}
        </div>

        {/* Right: Actions (Copy, Save indicator, Copilot restore toggle) */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {isSavedRecently && (
            <span className="text-[11px] font-medium text-emerald-600 flex items-center gap-1 pr-1 animate-in fade-in">
              <Check className="w-3 h-3" />
              <span>Saved</span>
            </span>
          )}

          <button
            onClick={handleCopy}
            className="p-1.5 rounded-lg text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-300/80 transition-all shadow-2xs"
            title="Copy content"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          {!isAgentOpen && onToggleAgent && (
            <button
              onClick={onToggleAgent}
              title="Show AI Copilot"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-300/80 shadow-2xs transition-all hover:border-indigo-300 flex-shrink-0"
            >
              <PanelRight className="w-3.5 h-3.5 text-indigo-600" />
              <span className="hidden sm:inline">Copilot</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Document Body */}
      <div className="flex-1 overflow-y-auto p-1 md:p-2 custom-scrollbar min-h-0">
        <div className="max-w-4xl mx-auto">
          {/* Raw Code Editor Tab (Source) */}
          {activeTab === 'code' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600 font-mono">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-indigo-600"></span>
                  <span className="font-semibold text-slate-800">section_{selectedNode.sectionNumber.replace(/\./g, '_')}.tex</span>
                </div>
              </div>
              <textarea
                value={localText}
                onChange={(e) => handleSaveText(e.target.value)}
                className="w-full min-h-[600px] p-5 bg-slate-950 font-mono text-xs text-indigo-200 leading-relaxed focus:outline-none resize-none selection:bg-indigo-600/40"
                spellCheck={false}
                placeholder="Type or edit Markdown and LaTeX equations ($...$ and $$...$$)..."
              />
            </div>
          )}

          {/* Live PDF Sheet Preview Tab (PDF) */}
          {activeTab === 'pdf' && (
            <div className="bg-white text-slate-900 rounded-xl p-2 md:p-14 shadow-sm font-serif max-w-3xl mx-auto border border-slate-200 min-h-[750px]">
              {/* PDF Header Mockup */}
              <div className="text-center border-b border-slate-200 pb-6 mb-8">
                <div className="text-[11px] uppercase tracking-widest text-slate-400 font-sans font-bold mb-1">
                  AutoGenBook Academic Monograph Series • Vol. 14
                </div>
                <h1 className="text-2xl md:text-3xl font-bold font-serif text-slate-900 tracking-tight">
                  {selectedNode.title}
                </h1>
                <div className="text-xs text-slate-500 mt-2 font-sans font-medium">
                  Section {selectedNode.sectionNumber} • AutoGenBook Synthesis Engine
                </div>
              </div>

              {/* Typeset Content */}
              <div className="pdf-prose text-slate-800 text-sm leading-relaxed space-y-4">
                <MathRenderer content={localText || '*(Section content is empty. Switch to Source to write or prompt the Copilot on the right to synthesize this section.)*'} />
              </div>

              {/* PDF Footer Mockup */}
              <div className="mt-16 pt-6 border-t border-slate-200 flex items-center justify-between text-xs text-slate-400 font-sans">
                <span>Page {pageEstimate}</span>
                <span>{selectedNode.title}</span>
                <span>[Typeset with STIX Two & KaTeX]</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Stage Editor Bottom Status Bar (Sticky at bottom of pane) */}
      <div className="h-8 bg-white border-t border-slate-200 px-4 md:px-6 flex items-center flex-shrink-0 z-10">
        <div className="w-full max-w-4xl mx-auto flex items-center justify-between text-[11px] text-slate-500 font-mono">
          <div className="flex items-center gap-3">
            <span>{wordCount} Words</span>
            <span className="text-slate-300">•</span>
            <span>~{pageEstimate} Pages</span>
            <span className="text-slate-300">•</span>
            <span className="text-indigo-600 font-semibold">{equationMatches.length} LaTeX Formulas</span>
          </div>

          <div className="flex items-center gap-2 font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            <span className="text-emerald-700">Ready</span>
          </div>
        </div>
      </div>
    </div>
  );
};
