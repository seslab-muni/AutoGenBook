import React, { useState } from 'react';
import { BookProject } from '../../types';
import { 
  Download, 
  PlusCircle, 
  Cpu, 
  Play, 
  Settings,
  Database,
  ChevronDown,
  BookOpen
} from 'lucide-react';

interface TopHeaderProps {
  currentBook: BookProject;
  books?: BookProject[];
  onSelectBook?: (bookId: string) => void;
  onNavigateHome: () => void;
  onOpenSourcesModal: () => void;
  onOpenNewModal: () => void;
  onOpenExportModal: () => void;
  onOpenSettingsModal: () => void;
  onStartBatchGeneration: () => void;
  isStreaming: boolean;
  totalWords: number;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  currentBook,
  books = [],
  onSelectBook,
  onNavigateHome,
  onOpenSourcesModal,
  onOpenNewModal,
  onOpenExportModal,
  onOpenSettingsModal,
  onStartBatchGeneration,
  isStreaming,
}) => {
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-3 sm:px-5 flex items-center justify-between gap-3 flex-shrink-0 z-40">
      {/* Left: Home Navigation & Project Metadata */}
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Project Icon / Home Link */}
        <div 
          onClick={onNavigateHome}
          title="Return to Projects Hub"
          className="flex items-center justify-center w-8 h-8 bg-indigo-600 rounded-lg text-white font-bold text-sm shadow-xs flex-shrink-0 cursor-pointer hover:bg-indigo-700 transition-colors"
        >
          Ω
        </div>

        {/* Project Selector & Title */}
        <div className="min-w-0 relative">
          <div className="flex items-center gap-1.5">
            <h1 className="font-bold text-sm text-slate-900 truncate tracking-tight">
              {currentBook.title}
            </h1>
            
            {books.length > 1 && onSelectBook && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
                  className="p-1 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-100"
                  title="Switch Project"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>

                {isProjectDropdownOpen && (
                  <div 
                    className="absolute top-full left-0 mt-1 w-64 bg-white border border-slate-200 rounded-xl shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100"
                    onMouseLeave={() => setIsProjectDropdownOpen(false)}
                  >
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                      Switch Project
                    </div>
                    {books.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => {
                          onSelectBook(b.id);
                          setIsProjectDropdownOpen(false);
                        }}
                        className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between hover:bg-indigo-50 transition-colors ${
                          b.id === currentBook.id ? 'font-bold text-indigo-700 bg-indigo-50/50' : 'text-slate-700'
                        }`}
                      >
                        <span className="truncate">{b.title}</span>
                        {b.id === currentBook.id && (
                          <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 flex-shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-slate-100 text-slate-600 border border-slate-200 hidden md:inline">
              v1.2-draft
            </span>
          </div>

          <p className="text-xs text-slate-500 truncate flex items-center gap-2 font-medium">
            <span>{currentBook.authors[0]}</span>
            <span>•</span>
            <span className="text-indigo-600 capitalize">{currentBook.targetAudience}</span>
          </p>
        </div>
      </div>

      {/* Right: Global Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Sources Explorer Button */}
        <button
          onClick={onOpenSourcesModal}
          title="View and Manage Project Sources & RAG Documents"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-indigo-50 text-indigo-700 hover:text-indigo-800 border border-slate-200 hover:border-indigo-200 transition-colors shadow-2xs"
        >
          <Database className="w-3.5 h-3.5 text-indigo-600" />
          <span>Sources</span>
          <span className="px-1.5 py-0.2 bg-indigo-100 text-indigo-800 rounded-full text-[10px] font-bold">
            {currentBook.sources.length}
          </span>
        </button>

        {/* Batch Generate / Stream Button */}
        <button
          onClick={onStartBatchGeneration}
          disabled={isStreaming}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all shadow-xs ${
            isStreaming
              ? 'bg-amber-50 text-amber-700 border border-amber-200 animate-pulse'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white'
          }`}
        >
          {isStreaming ? (
            <>
              <Cpu className="w-3.5 h-3.5 animate-spin text-amber-600" />
              <span>Synthesizing...</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-current" />
              <span className="hidden sm:inline">Multi-Agent Run</span>
            </>
          )}
        </button>

        {/* Export LaTeX/PDF */}
        <button
          onClick={onOpenExportModal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition-colors shadow-xs"
        >
          <Download className="w-3.5 h-3.5 text-slate-500" />
          <span className="hidden md:inline">Export</span>
        </button>

        {/* Project Settings */}
        <button
          onClick={onOpenSettingsModal}
          title="Project Settings (Max Outline Levels, Audience, Math Rigor)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition-colors shadow-xs"
        >
          <Settings className="w-3.5 h-3.5 text-slate-500" />
          <span className="hidden lg:inline">Settings</span>
        </button>

        {/* New Book Project */}
        <button
          onClick={onOpenNewModal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white transition-colors shadow-xs"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span className="hidden md:inline">New Project</span>
        </button>
      </div>
    </header>
  );
};

