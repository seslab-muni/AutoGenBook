/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { BookProject } from '../../types';
import { Trash2, AlertTriangle, X } from 'lucide-react';

interface DeleteProjectModalProps {
  isOpen: boolean;
  project: BookProject | null;
  onClose: () => void;
  onConfirmDelete: (projectId: string) => void;
}

export const DeleteProjectModal: React.FC<DeleteProjectModalProps> = ({
  isOpen,
  project,
  onClose,
  onConfirmDelete,
}) => {
  if (!isOpen || !project) return null;

  const handleConfirm = () => {
    onConfirmDelete(project.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
      <div 
        className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-rose-600 flex-shrink-0">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h2 id="delete-project-title" className="text-base font-bold text-slate-900">
                Delete Monograph Project
              </h2>
              <p className="text-xs text-slate-500">
                Confirm project deletion
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5 space-y-4">
          <div className="p-3.5 bg-rose-50/70 border border-rose-200/80 rounded-xl flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-rose-900 leading-relaxed">
              <span className="font-semibold block mb-0.5">This action cannot be undone.</span>
              All hierarchical chapter outlines, synthesized markdown and LaTeX formulas, and local drafts for this project will be permanently removed.
            </div>
          </div>

          <div className="space-y-1.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200/70">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Project to delete
            </div>
            <div className="text-sm font-bold text-slate-900 line-clamp-2">
              {project.title}
            </div>
            {project.subtitle && (
              <div className="text-xs text-slate-500 line-clamp-1">
                {project.subtitle}
              </div>
            )}
          </div>
        </div>

        {/* Actions Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl transition-colors shadow-2xs"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-colors shadow-2xs"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Project</span>
          </button>
        </div>
      </div>
    </div>
  );
};
