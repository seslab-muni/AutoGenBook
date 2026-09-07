import React, { useState } from 'react';
import { BookProject } from '../../types';
import { 
  X, 
  Download, 
  FileCode, 
  FileText, 
  Check, 
  Copy, 
  Layers, 
  Printer 
} from 'lucide-react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  book: BookProject;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  book,
}) => {
  const [activeTab, setActiveTab] = useState<'latex' | 'bibtex' | 'markdown'>('latex');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const sampleLatexBundle = `\\documentclass[11pt,twoside,openright]{book}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,amsfonts,amsthm}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{cite}

\\geometry{a4paper, margin=1in}

\\title{${book.title}}
\\subtitle{${book.subtitle}}
\\author{${book.authors.join(' \\and ')}}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents

% ==============================
% AutoGenBook Generated Chapters
% ==============================
${book.outline.map((ch) => `\\include{chapters/chapter_${ch.sectionNumber}}`).join('\n')}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`;

  const sampleBibtex = `@article{lamport1982byzantine,
  title={The Byzantine Generals Problem},
  author={Lamport, Leslie and Shostak, Robert and Pease, Marshall},
  journal={ACM Transactions on Programming Languages and Systems (TOPLAS)},
  volume={4},
  number={3},
  pages={382--401},
  year={1982},
  publisher={ACM New York, NY, USA}
}

@article{fowler2012surface,
  title={Surface codes: Towards practical large-scale quantum computation},
  author={Fowler, Austin G and Mariantoni, Matteo and Martinis, John M and Cleland, Andrew N},
  journal={Physical Review A},
  volume={86},
  number={3},
  pages={032324},
  year={2012},
  publisher={APS}
}`;

  const sampleMarkdown = `# ${book.title}\n## ${book.subtitle}\n\n**Authors:** ${book.authors.join(', ')}\n\n---\n\n` +
    book.outline.map((ch) => `${ch.contentMarkdown}\n\n${(ch.children || []).map((sec) => `${sec.contentMarkdown}`).join('\n\n')}`).join('\n\n---\n\n');

  const contentToDisplay =
    activeTab === 'latex' ? sampleLatexBundle : activeTab === 'bibtex' ? sampleBibtex : sampleMarkdown;

  const handleCopy = () => {
    navigator.clipboard.writeText(contentToDisplay);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([contentToDisplay], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download =
      activeTab === 'latex' ? `${book.id}_main.tex` : activeTab === 'bibtex' ? 'references.bib' : `${book.id}_book.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-3xl overflow-hidden shadow-xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-indigo-600" />
            <h2 className="text-sm font-bold text-slate-900">
              Export Academic Bundle ({book.title})
            </h2>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-800 rounded-lg hover:bg-slate-200/70 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Controls */}
        <div className="p-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
            <button
              onClick={() => setActiveTab('latex')}
              className={`px-3 py-1 rounded-md font-semibold text-xs transition-all ${
                activeTab === 'latex' ? 'bg-white text-indigo-600 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              LaTeX Package (main.tex)
            </button>
            <button
              onClick={() => setActiveTab('bibtex')}
              className={`px-3 py-1 rounded-md font-semibold text-xs transition-all ${
                activeTab === 'bibtex' ? 'bg-white text-indigo-600 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              BibTeX (references.bib)
            </button>
            <button
              onClick={() => setActiveTab('markdown')}
              className={`px-3 py-1 rounded-md font-semibold text-xs transition-all ${
                activeTab === 'markdown' ? 'bg-white text-indigo-600 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Full Markdown
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold shadow-2xs transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download File</span>
            </button>
          </div>
        </div>

        {/* Code Content */}
        <div className="flex-1 overflow-y-auto p-4 bg-slate-950 font-mono text-xs text-indigo-200 custom-scrollbar leading-relaxed">
          <pre className="whitespace-pre-wrap">{contentToDisplay}</pre>
        </div>

        {/* Footer */}
        <div className="p-3.5 bg-[#F8FAFC] border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Ready for pdflatex, xelatex, or Overleaf compilation</span>
          <span className="font-mono text-indigo-600 font-bold">Total chapters: {book.outline.length}</span>
        </div>
      </div>
    </div>
  );
};
