import React, { useState } from 'react';
import { BookProject, AudienceLevel } from '../../types';
import { 
  X, 
  Settings, 
  Layers, 
  Sigma, 
  BookOpen, 
  Check, 
  Sliders
} from 'lucide-react';

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBook: BookProject;
  onSaveSettings: (updatedBook: Partial<BookProject>) => void;
}

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({
  isOpen,
  onClose,
  currentBook,
  onSaveSettings,
}) => {
  const [title, setTitle] = useState(currentBook.title);
  const [subtitle, setSubtitle] = useState(currentBook.subtitle);
  const [targetAudience, setTargetAudience] = useState<AudienceLevel>(currentBook.targetAudience);
  const [totalPagesBudget, setTotalPagesBudget] = useState<number>(currentBook.totalPagesBudget);
  const [equationFrequencyLevel, setEquationFrequencyLevel] = useState<number>(currentBook.equationFrequencyLevel);
  const [maxOutlineLevels, setMaxOutlineLevels] = useState<number>(currentBook.maxOutlineLevels ?? 3);
  const [outputFormat, setOutputFormat] = useState<'latex' | 'markdown' | 'pdf'>(currentBook.outputFormat);
  const [doConsiderOutline, setDoConsiderOutline] = useState<boolean>(currentBook.doConsiderOutline);
  const [doConsiderPreviousSections, setDoConsiderPreviousSections] = useState<boolean>(currentBook.doConsiderPreviousSections);

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveSettings({
      title,
      subtitle,
      targetAudience,
      totalPagesBudget,
      equationFrequencyLevel,
      maxOutlineLevels,
      outputFormat,
      doConsiderOutline,
      doConsiderPreviousSections,
      updatedAt: new Date().toISOString().split('T')[0],
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-xl w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-[#F8FAFC]">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Project Settings</h2>
              <p className="text-xs text-slate-500">Configure global generation bounds, math rigor, and outline depth</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Title & Subtitle */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Book Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-[#F8FAFC] border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Subtitle</label>
              <input
                type="text"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                className="w-full bg-[#F8FAFC] border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Target Audience */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Target Audience</label>
            <select
              value={targetAudience}
              onChange={(e) => setTargetAudience(e.target.value as AudienceLevel)}
              className="w-full bg-[#F8FAFC] border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            >
              <option value="undergraduate">Undergraduate Level</option>
              <option value="graduate">Graduate Level (Standard)</option>
              <option value="phd_researcher">PhD / Advanced Researcher</option>
              <option value="industry_practitioner">Industry Practitioner</option>
            </select>
          </div>

          {/* Total Page Budget (5-500, step 5 with input & slider) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-indigo-600" />
                <span>Target Page Budget</span>
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="5"
                  max="500"
                  step="5"
                  value={totalPagesBudget}
                  onChange={(e) => setTotalPagesBudget(Math.max(5, Math.min(500, parseInt(e.target.value) || 5)))}
                  className="w-16 px-2 py-0.5 bg-white border border-slate-300 rounded-md font-mono text-xs font-bold text-indigo-700 text-right focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <span className="text-xs text-slate-500 font-medium">Pages</span>
              </div>
            </div>
            <input
              type="range"
              min="5"
              max="500"
              step="5"
              value={totalPagesBudget}
              onChange={(e) => setTotalPagesBudget(parseInt(e.target.value))}
              className="w-full accent-indigo-600"
            />
            <div className="flex justify-between text-[10px] text-slate-400 font-mono">
              <span>5p (Brief)</span>
              <span>250p (Monograph)</span>
              <span>500p (Treatise)</span>
            </div>
          </div>

          {/* Max Outline Levels (Hierarchy Depth) Slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-indigo-600" />
                <span>Max Outline Depth</span>
              </label>
              <span className="text-xs font-mono font-semibold text-indigo-600">Level {maxOutlineLevels} / 5</span>
            </div>
            <input
              type="range"
              min="1"
              max="5"
              step="1"
              value={maxOutlineLevels}
              onChange={(e) => setMaxOutlineLevels(parseInt(e.target.value))}
              className="w-full accent-indigo-600"
            />
            <div className="flex justify-between text-[10px] text-slate-400 font-mono">
              <span>1 (Chapters)</span>
              <span>3 (Subsections)</span>
              <span>5 (Deep)</span>
            </div>
          </div>

          {/* Equation Frequency Level Slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <Sigma className="w-3.5 h-3.5 text-emerald-600" />
                <span>Default Math Equation Density</span>
              </label>
              <span className="text-xs font-mono font-semibold text-slate-700">Level {equationFrequencyLevel} / 5</span>
            </div>
            <input
              type="range"
              min="1"
              max="5"
              step="1"
              value={equationFrequencyLevel}
              onChange={(e) => setEquationFrequencyLevel(parseInt(e.target.value))}
              className="w-full accent-indigo-600"
            />
            <div className="flex justify-between text-[10px] text-slate-400 font-mono">
              <span>1 (Conceptual)</span>
              <span>3 (Standard)</span>
              <span>5 (Formal Proofs)</span>
            </div>
          </div>

          {/* Context switches */}
          <div className="pt-2 space-y-2 border-t border-slate-200">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={doConsiderOutline}
                onChange={(e) => setDoConsiderOutline(e.target.checked)}
                className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4"
              />
              <span className="text-xs font-medium text-slate-700">Consider global outline during recursive section generation</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={doConsiderPreviousSections}
                onChange={(e) => setDoConsiderPreviousSections(e.target.checked)}
                className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4"
              />
              <span className="text-xs font-medium text-slate-700">Pass preceding section context & lemma definitions to Writer Agent</span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 bg-[#F8FAFC] flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-xs font-semibold text-white shadow-xs transition-colors flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Save Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
};
