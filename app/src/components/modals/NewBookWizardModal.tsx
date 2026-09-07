import React, { useState } from 'react';
import { BookProject, AudienceLevel, IngestedSource } from '../../types';
import { 
  X, 
  BookOpen, 
  Upload, 
  Sparkles, 
  FileText, 
  Sigma, 
  Layers, 
  Check, 
  Plus, 
  Trash2,
  Cpu,
  ArrowRight
} from 'lucide-react';

interface NewBookWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateBook: (book: BookProject) => void;
}

export const NewBookWizardModal: React.FC<NewBookWizardModalProps> = ({
  isOpen,
  onClose,
  onCreateBook,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState<AudienceLevel>('graduate');
  const [pageBudget, setPageBudget] = useState<number>(350);
  const [equationDensity, setEquationDensity] = useState<number>(4);
  const [maxOutlineLevels, setMaxOutlineLevels] = useState<number>(3);
  const [doConsiderOutline, setDoConsiderOutline] = useState<boolean>(true);
  const [doConsiderPreviousSections, setDoConsiderPreviousSections] = useState<boolean>(true);
  const [uploadedSources, setUploadedSources] = useState<IngestedSource[]>([
    {
      id: 'src-init-1',
      name: 'Curriculum_Core_Monograph_Draft.pdf',
      size: '3.4 MB',
      type: 'pdf',
      chunksCount: 82,
      uploadDate: '2026-08-25',
      status: 'indexed',
    },
  ]);

  if (!isOpen) return null;

  const handleAddSampleSource = () => {
    const newSrc: IngestedSource = {
      id: `src-${Date.now()}`,
      name: 'Advanced_Topics_Lecture_Slides_2026.pdf',
      size: '5.1 MB',
      type: 'slides',
      chunksCount: 120,
      uploadDate: '2026-08-25',
      status: 'indexed',
    };
    setUploadedSources([...uploadedSources, newSrc]);
  };

  const handleRemoveSource = (id: string) => {
    setUploadedSources(uploadedSources.filter((s) => s.id !== id));
  };

  const handleFinalize = () => {
    const bookTitle = title.trim() || 'Modern Foundations of Computational Sciences';
    const newBook: BookProject = {
      id: `book-${Date.now()}`,
      title: bookTitle,
      subtitle: subtitle.trim() || 'A Rigorous Recursive Synthesis',
      authors: ['Lead Author & AutoGenBook Multi-Agent Team'],
      topic: topic.trim() || 'Foundational Principles, Formal Proofs, and System Architectures',
      targetAudience: audience,
      totalPagesBudget: pageBudget,
      equationFrequencyLevel: equationDensity,
      maxOutlineLevels,
      doConsiderOutline,
      doConsiderPreviousSections,
      outputFormat: 'latex',
      sources: uploadedSources,
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
      outline: [
        {
          id: `ch-init-1`,
          title: 'Introduction and Foundational Principles',
          sectionNumber: '1',
          level: 1,
          status: 'not_started',
          targetPages: Math.round(pageBudget * 0.25),
          wordBudget: Math.round(pageBudget * 0.25 * 320),
          actualWords: 0,
          equationDensityLevel: equationDensity,
          mathLevel: 'rigorous',
          subPrompt: 'Establish core axioms, formal notations, and theoretical framing.',
          contentMarkdown: `# Chapter 1: Introduction and Foundational Principles\n\n*(Ready for Multi-Agent recursive generation.)*`,
          contentLatex: `\\chapter{Introduction and Foundational Principles}`,
          ragCitations: [],
          children: [
            {
              id: `sec-init-1-1`,
              title: 'Formal Model & Mathematical Setting',
              sectionNumber: '1.1',
              level: 2,
              status: 'not_started',
              targetPages: Math.round(pageBudget * 0.12),
              wordBudget: Math.round(pageBudget * 0.12 * 320),
              actualWords: 0,
              equationDensityLevel: equationDensity,
              mathLevel: 'formal_proof',
              contentMarkdown: `### 1.1 Formal Model & Mathematical Setting\n\nLet $\\mathcal{X}$ denote the state manifold.`,
              contentLatex: `\\section{Formal Model}`,
              ragCitations: [],
            },
            {
              id: `sec-init-1-2`,
              title: 'Axiomatic Bounds & Contraction Mappings',
              sectionNumber: '1.2',
              level: 2,
              status: 'not_started',
              targetPages: Math.round(pageBudget * 0.13),
              wordBudget: Math.round(pageBudget * 0.13 * 320),
              actualWords: 0,
              equationDensityLevel: equationDensity,
              mathLevel: 'formal_proof',
              contentMarkdown: `### 1.2 Axiomatic Bounds\n\n$$\\|\\mathcal{T}x - \\mathcal{T}y\\| \\le \\gamma \\|x - y\\|$$`,
              contentLatex: `\\section{Axiomatic Bounds}`,
              ragCitations: [],
            },
          ],
        },
        {
          id: `ch-init-2`,
          title: 'Advanced System Architectures & Empirical Benchmarks',
          sectionNumber: '2',
          level: 1,
          status: 'not_started',
          targetPages: Math.round(pageBudget * 0.35),
          wordBudget: Math.round(pageBudget * 0.35 * 320),
          actualWords: 0,
          equationDensityLevel: equationDensity,
          mathLevel: 'applied',
          subPrompt: 'Synthesize distributed runtime considerations with theoretical guarantees.',
          contentMarkdown: `# Chapter 2: Advanced System Architectures\n\n*(Queued for synthesis.)*`,
          contentLatex: `\\chapter{Advanced System Architectures}`,
          ragCitations: [],
          children: [
            {
              id: `sec-init-2-1`,
              title: 'Scalability Trade-Offs & Complexity Bounds',
              sectionNumber: '2.1',
              level: 2,
              status: 'not_started',
              targetPages: Math.round(pageBudget * 0.18),
              wordBudget: Math.round(pageBudget * 0.18 * 320),
              actualWords: 0,
              equationDensityLevel: equationDensity,
              mathLevel: 'rigorous',
              contentMarkdown: ``,
              contentLatex: ``,
              ragCitations: [],
            },
          ],
        },
      ],
    };

    onCreateBook(newBook);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl overflow-hidden shadow-xl flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="p-4 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center shadow-xs">
              <BookOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                New AutoGenBook Project Wizard
              </h2>
              <p className="text-xs text-slate-500">
                Configure recursive planning parameters, source materials & target scope
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-800 rounded-lg hover:bg-slate-200/70 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step Navigation Pill */}
        <div className="px-6 pt-4 pb-3 flex items-center justify-between border-b border-slate-200 bg-[#F8FAFC] text-xs">
          <div
            onClick={() => setStep(1)}
            className={`flex items-center gap-2 cursor-pointer ${
              step === 1 ? 'text-indigo-600 font-bold' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
              step === 1 ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'
            }`}>1</span>
            <span>Metadata & Scope</span>
          </div>
          <div className="w-8 h-px bg-slate-200"></div>
          <div
            onClick={() => setStep(2)}
            className={`flex items-center gap-2 cursor-pointer ${
              step === 2 ? 'text-indigo-600 font-bold' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
              step === 2 ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'
            }`}>2</span>
            <span>RAG Sources</span>
          </div>
          <div className="w-8 h-px bg-slate-200"></div>
          <div
            onClick={() => setStep(3)}
            className={`flex items-center gap-2 cursor-pointer ${
              step === 3 ? 'text-indigo-600 font-bold' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
              step === 3 ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'
            }`}>3</span>
            <span>Planning & Math</span>
          </div>
        </div>

        {/* Step 1: Metadata */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4 text-xs">
          {step === 1 && (
            <>
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Book / Monograph Title</label>
                <input
                  type="text"
                  placeholder="e.g. Statistical Mechanics & Non-Equilibrium Field Theory"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Subtitle or Academic Focus</label>
                <input
                  type="text"
                  placeholder="e.g. A Graduate Treatise on Renormalization and Critical Phenomena"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Target Audience</label>
                  <select
                    value={audience}
                    onChange={(e) => setAudience(e.target.value as AudienceLevel)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-900 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs cursor-pointer"
                  >
                    <option value="undergraduate">Undergraduate Students</option>
                    <option value="graduate">Graduate (Masters / PhD)</option>
                    <option value="phd_researcher">PhD Researcher / Specialist</option>
                    <option value="industry_practitioner">Industry Practitioner</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-bold text-slate-700">Target Pages Budget</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="5"
                        max="500"
                        step="5"
                        value={pageBudget}
                        onChange={(e) => setPageBudget(Math.max(5, Math.min(500, parseInt(e.target.value) || 5)))}
                        className="w-14 px-1.5 py-0.5 bg-white border border-slate-300 rounded font-mono text-xs font-bold text-indigo-700 text-right focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-slate-500 font-medium">p</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="500"
                    step="5"
                    value={pageBudget}
                    onChange={(e) => setPageBudget(parseInt(e.target.value))}
                    className="w-full accent-indigo-600 mt-1"
                  />
                  <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                    <span>5p (Brief)</span>
                    <span>250p (Monograph)</span>
                    <span>500p (Treatise)</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Step 2: Sources */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="p-5 border-2 border-dashed border-slate-300 hover:border-indigo-400 rounded-xl text-center cursor-pointer transition-colors bg-slate-50/50">
                <Upload className="w-6 h-6 text-slate-400 mx-auto mb-1.5" />
                <p className="font-bold text-slate-800">Drag & Drop Reference Materials</p>
                <p className="text-[11px] text-slate-500 mt-0.5">Supports PDF papers, lecture slide decks, syllabus, and raw notes.</p>
                <button
                  type="button"
                  onClick={handleAddSampleSource}
                  className="mt-3 px-3.5 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 text-indigo-700 rounded-lg text-xs font-semibold shadow-2xs transition-colors"
                >
                  + Add Sample Academic Slides
                </button>
              </div>

              <div className="space-y-2">
                <span className="font-bold text-slate-700">Indexed Sources ({uploadedSources.length})</span>
                {uploadedSources.map((s) => (
                  <div key={s.id} className="p-3 bg-white border border-slate-200 rounded-xl flex items-center justify-between shadow-2xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                      <div className="truncate">
                        <div className="text-slate-900 font-bold truncate">{s.name}</div>
                        <div className="text-[10px] text-slate-500 font-mono">{s.size} • {s.chunksCount} Vector Chunks</div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveSource(s.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Math Rigor & Recursive Planning */}
          {step === 3 && (
            <div className="space-y-4">
              {/* Equation Density Rigor */}
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700 flex justify-between">
                  <span>Equation Density Rigor Level</span>
                  <span className="font-mono text-indigo-600 font-bold">Level {equationDensity} of 5</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={equationDensity}
                  onChange={(e) => setEquationDensity(parseInt(e.target.value))}
                  className="w-full accent-indigo-600"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>1 (Conceptual)</span>
                  <span>3 (Standard)</span>
                  <span>5 (Formal Proofs)</span>
                </div>
              </div>

              {/* Max Outline Depth Slider */}
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700 flex justify-between">
                  <span>Max Outline Depth</span>
                  <span className="font-mono text-indigo-600 font-bold">Level {maxOutlineLevels} of 5</span>
                </label>
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

              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <span className="font-bold text-slate-800">Multi-Agent Memory & Hierarchy</span>
                <label className="flex items-center gap-2 text-slate-700 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={doConsiderOutline}
                    onChange={(e) => setDoConsiderOutline(e.target.checked)}
                    className="accent-indigo-600 rounded"
                  />
                  <span>Consider Global Outline when drafting child leaves</span>
                </label>
                <label className="flex items-center gap-2 text-slate-700 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={doConsiderPreviousSections}
                    onChange={(e) => setDoConsiderPreviousSections(e.target.checked)}
                    className="accent-indigo-600 rounded"
                  />
                  <span>Inject Previous Section Summaries to prevent redundancy</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-[#F8FAFC] border-t border-slate-200 flex items-center justify-between">
          {step > 1 ? (
            <button
              onClick={() => setStep((s) => (s - 1) as any)}
              className="px-3.5 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold shadow-2xs transition-colors"
            >
              Back
            </button>
          ) : (
            <div />
          )}

          {step < 3 ? (
            <button
              onClick={() => setStep((s) => (s + 1) as any)}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1 shadow-xs transition-colors"
            >
              <span>Next</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          ) : (
            <button
              onClick={handleFinalize}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-xs transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Initialize & Plan Outline</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
