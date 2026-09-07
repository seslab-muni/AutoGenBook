import React, { useState } from 'react';
import { UIVariant } from '../../types';
import { Columns3, LayoutGrid, BookText, Check, ChevronDown, Sparkles, Info, Eye } from 'lucide-react';

interface VariantSelectorBarProps {
  activeVariant: UIVariant;
  onSelectVariant: (variant: UIVariant) => void;
}

export const VariantSelectorBar: React.FC<VariantSelectorBarProps> = ({
  activeVariant,
  onSelectVariant,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const variants = [
    {
      id: 'structured-architect' as UIVariant,
      title: 'Variant 1: "The Structured Architect"',
      subtitle: 'Classic Academic IDE • Split-Pane 3-Column Workstation',
      icon: Columns3,
      badge: 'Specification Default',
      badgeColor: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      description:
        'Features a deep hierarchical Outline Tree on the left, a multi-mode Stage Editor in the center (Visual LaTeX/Markdown + Raw Code + PDF sheet), and a live Multi-Agent SSE Telemetry & Citation Inspector drawer on the right.',
      highlights: ['Deep Tree Explorer', 'Multi-tab Editor & Live PDF', 'Real-time Agent Drawer & RAG Citations'],
    },
    {
      id: 'canvas-graph' as UIVariant,
      title: 'Variant 2: "The Canvas & Graph Workbench"',
      subtitle: 'Interactive DAG Network • Recursive Node Map & Focus Studio',
      icon: LayoutGrid,
      badge: 'Visual Exploration',
      badgeColor: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      description:
        'Visualizes the entire book chapter hierarchy as an interactive topological NetworkX DAG. Lets authors pan/zoom chapter clusters, inspect status halos, and slide in a focused math desk with instant AI theorem provers.',
      highlights: ['Topological DAG Graph', 'Interactive Node Clusters', 'Slide-over Focused Math Desk'],
    },
    {
      id: 'manuscript-press' as UIVariant,
      title: 'Variant 3: "The Manuscript Press"',
      subtitle: 'Double-Page Galley Typesetter • Publishing Deck & Bottom Telemetry',
      icon: BookText,
      badge: 'Publishing & Typesetting',
      badgeColor: 'bg-amber-50 text-amber-700 border-amber-200',
      description:
        'Focuses on true academic galley proof aesthetics: dual-page side-by-side typesetting with STIX/Crimson typography, live margin notes, equation counters, fast HUD tree, and a high-density bottom Agent Execution Terminal.',
      highlights: ['Dual-Page Galley Layout', 'Margin Notes & LaTeX Math', 'Bottom Agent Telemetry Console'],
    },
  ];

  return (
    <div className="bg-[#F8FAFC] border-b border-slate-200 px-6 py-2.5 transition-all">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-semibold">
              <Sparkles className="w-3 h-3 text-indigo-600" />
              <span>UI Architecture Variants</span>
            </div>
            <p className="text-xs text-slate-500 font-medium hidden md:inline">
              Compare and toggle between three interactive layout paradigms:
            </p>
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs text-slate-500 hover:text-slate-900 font-medium flex items-center gap-1 transition-colors"
          >
            <span>{isExpanded ? 'Collapse Details' : 'Show Variant Details'}</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {isExpanded && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5 pt-1 pb-1">
            {variants.map((v) => {
              const isSelected = activeVariant === v.id;
              const Icon = v.icon;

              return (
                <div
                  key={v.id}
                  onClick={() => onSelectVariant(v.id)}
                  className={`relative p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between group bg-white shadow-xs ${
                    isSelected
                      ? `border-indigo-600 ring-2 ring-indigo-200 bg-indigo-50/30 shadow-sm`
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/50'
                  }`}
                >
                  <div>
                    {/* Top Row: Icon, Title, Badge */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'bg-indigo-600 text-white'
                              : 'bg-slate-100 text-slate-600 group-hover:bg-slate-200'
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                            {v.title}
                          </div>
                          <div className="text-[11px] text-slate-500 font-medium leading-tight">
                            {v.subtitle}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border ${v.badgeColor}`}>
                          {v.badge}
                        </span>
                        {isSelected && (
                          <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center">
                            <Check className="w-2.5 h-2.5" />
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Description */}
                    <p className="text-xs text-slate-600 leading-relaxed mb-3 font-normal">
                      {v.description}
                    </p>
                  </div>

                  {/* Highlights & Select Action */}
                  <div>
                    <div className="flex flex-wrap gap-1 mb-3">
                      {v.highlights.map((h, i) => (
                        <span
                          key={i}
                          className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 font-medium"
                        >
                          {h}
                        </span>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectVariant(v.id);
                      }}
                      className={`w-full py-1.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-xs ${
                        isSelected
                          ? 'bg-indigo-600 text-white shadow-indigo-100'
                          : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>{isSelected ? 'Active Layout' : 'Select Layout'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
