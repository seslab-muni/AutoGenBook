/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { OutlineNode } from '../../types';
import { Trash2, AlertTriangle, X, Layers } from 'lucide-react';

interface DeleteNodeModalProps {
  isOpen: boolean;
  node: OutlineNode | null;
  onClose: () => void;
  onConfirmDelete: (nodeId: string) => void;
}

export const DeleteNodeModal: React.FC<DeleteNodeModalProps> = ({
  isOpen,
  node,
  onClose,
  onConfirmDelete,
}) => {
  if (!isOpen || !node) return null;

  const countAllChildren = (item: OutlineNode): number => {
    if (!item.children || item.children.length === 0) return 0;
    let count = item.children.length;
    for (const child of item.children) {
      count += countAllChildren(child);
    }
    return count;
  };

  const totalDescendants = countAllChildren(node);
  const hasChildren = totalDescendants > 0;

  const handleConfirm = () => {
    onConfirmDelete(node.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs font-sans">
      <div 
        className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-node-title"
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-rose-600 flex-shrink-0">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h2 id="delete-node-title" className="text-base font-bold text-slate-900">
                Delete {node.level === 1 ? 'Chapter' : 'Section'}
              </h2>
              <p className="text-xs text-slate-500">
                Confirm removal from outline
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
              {hasChildren ? (
                <>
                  This item contains <span className="font-bold">{totalDescendants} nested sub-section{totalDescendants === 1 ? '' : 's'}</span>. Deleting it will permanently remove the entire branch, including all drafted text and mathematical formulas.
                </>
              ) : (
                <>
                  All drafted markdown text, synthesized LaTeX proofs, and citation links for this section will be permanently deleted.
                </>
              )}
            </div>
          </div>

          <div className="space-y-1.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200/70">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>Selected Section</span>
              <span className="font-mono text-slate-400">§{node.sectionNumber}</span>
            </div>
            <div className="text-sm font-bold text-slate-900 line-clamp-2">
              {node.title}
            </div>
            {hasChildren && (
              <div className="flex items-center gap-1.5 text-xs text-amber-700 font-medium pt-1">
                <Layers className="w-3.5 h-3.5 text-amber-600" />
                <span>Includes {totalDescendants} nested child section{totalDescendants === 1 ? '' : 's'}</span>
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
            <span>Delete {node.level === 1 ? 'Chapter' : 'Section'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
