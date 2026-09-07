/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { BookProject } from '../../types';
import { DeleteProjectModal } from '../modals/DeleteProjectModal';
import { 
  Plus, 
  Search, 
  Clock, 
  ArrowRight, 
  Database,
  Trash2,
  FileText
} from 'lucide-react';

interface WelcomeProjectsViewProps {
  books: BookProject[];
  onSelectProject: (bookId: string) => void;
  onOpenNewModal: () => void;
  onDeleteProject: (bookId: string) => void;
  onDuplicateProject: (book: BookProject) => void;
}

export const WelcomeProjectsView: React.FC<WelcomeProjectsViewProps> = ({
  books,
  onSelectProject,
  onOpenNewModal,
  onDeleteProject,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [projectToDelete, setProjectToDelete] = useState<BookProject | null>(null);

  const filteredBooks = books.filter((book) => {
    return (
      book.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      book.subtitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
      book.topic.toLowerCase().includes(searchQuery.toLowerCase()) ||
      book.authors.some((a) => a.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  });

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col font-sans">
      {/* Top Welcome Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-2xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center text-white font-bold text-base shadow-sm">
              Ω
            </div>
            <div>
              <h1 className="font-extrabold text-base text-slate-900 tracking-tight">
                AutoGenBook Studio
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onOpenNewModal}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-colors shadow-xs"
            >
              <Plus className="w-4 h-4" />
              <span>New Project</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Search & Filter Toolbar */}
        <div className="flex items-center justify-between gap-4 bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search monographs by title, topic, or authors..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-8 py-2 bg-slate-50/70 border border-slate-200 rounded-lg text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 font-medium"
              >
                Clear
              </button>
            )}
          </div>

          <div className="text-xs text-slate-500 font-medium">
            {filteredBooks.length} {filteredBooks.length === 1 ? 'Project' : 'Projects'}
          </div>
        </div>

        {/* Projects Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredBooks.map((book) => {
            return (
              <div
                key={book.id}
                onClick={() => onSelectProject(book.id)}
                className="group bg-white rounded-2xl border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all duration-200 flex flex-col justify-between cursor-pointer p-6 relative overflow-hidden"
              >
                {/* Top Content */}
                <div className="space-y-3">
                  {/* Meta Bar */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{book.updatedAt}</span>
                    </div>

                    {books.length > 1 && (
                      <button
                        type="button"
                        title="Delete Project"
                        onClick={(e) => {
                          e.stopPropagation();
                          setProjectToDelete(book);
                        }}
                        className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Title & Subtitle */}
                  <div className="space-y-1">
                    <h3 className="font-bold text-slate-900 text-base group-hover:text-indigo-600 transition-colors leading-snug line-clamp-2">
                      {book.title}
                    </h3>
                    {book.subtitle && (
                      <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">
                        {book.subtitle}
                      </p>
                    )}
                  </div>

                  {/* Authors */}
                  {book.authors && book.authors.length > 0 && (
                    <p className="text-xs text-slate-500 truncate pt-1">
                      By {book.authors.join(', ')}
                    </p>
                  )}
                </div>

                {/* Bottom Footer: Clean Info & Action */}
                <div className="pt-5 mt-4 border-t border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <div className="flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5 text-slate-400" />
                      <span>{book.totalPagesBudget}p</span>
                    </div>
                    <div className="w-1 h-1 rounded-full bg-slate-300" />
                    <div className="flex items-center gap-1">
                      <Database className="w-3.5 h-3.5 text-slate-400" />
                      <span>{book.sources.length} sources</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 text-xs font-semibold text-indigo-600 group-hover:text-indigo-700 transition-colors">
                    <span>Open</span>
                    <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* Delete Project Confirmation Modal */}
      <DeleteProjectModal
        isOpen={Boolean(projectToDelete)}
        project={projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirmDelete={(projectId) => {
          onDeleteProject(projectId);
          setProjectToDelete(null);
        }}
      />
    </div>
  );
};
