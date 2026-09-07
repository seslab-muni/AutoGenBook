import React, { useState, useMemo } from 'react';
import { BookProject, IngestedSource } from '../../types';
import { 
  X, 
  Upload, 
  Search, 
  LayoutGrid, 
  List, 
  Plus, 
  Trash2, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  FileText, 
  BookOpen, 
  Sparkles, 
  ExternalLink, 
  Copy, 
  Check, 
  Layers, 
  Database,
  ArrowUpDown,
  Filter
} from 'lucide-react';

interface SourcesExplorerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBook: BookProject;
  onAddSource: (source: IngestedSource) => void;
  onDeleteSource: (sourceId: string) => void;
}

type ViewMode = 'grid' | 'list';
type IngestTab = 'upload' | 'arxiv' | 'bibtex' | 'url';

export const SourcesExplorerModal: React.FC<SourcesExplorerModalProps> = ({
  isOpen,
  onClose,
  currentBook,
  onAddSource,
  onDeleteSource,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);
  const [ingestTab, setIngestTab] = useState<IngestTab>('upload');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Ingestion form state
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadFileType, setUploadFileType] = useState<IngestedSource['type']>('pdf');
  const [uploadAuthors, setUploadAuthors] = useState('');
  const [uploadYear, setUploadYear] = useState('2026');
  const [arxivId, setArxivId] = useState('');
  const [bibtexContent, setBibtexContent] = useState('');
  const [urlAddress, setUrlAddress] = useState('');
  const [isIngesting, setIsIngesting] = useState(false);

  // Compute reference count from outline ragCitations
  const sourceCitationCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const traverse = (nodes: typeof currentBook.outline) => {
      nodes.forEach((node) => {
        (node.ragCitations || []).forEach((c) => {
          counts[c.sourceDoc] = (counts[c.sourceDoc] || 0) + 1;
        });
        if (node.children) traverse(node.children);
      });
    };
    traverse(currentBook.outline);
    return counts;
  }, [currentBook]);

  if (!isOpen) return null;

  const filteredSources = currentBook.sources.filter((s) => {
    const matchesSearch = 
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.authors && s.authors.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (s.description && s.description.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesType = typeFilter === 'all' || s.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const getFormatBadge = (type: IngestedSource['type']) => {
    switch (type) {
      case 'pdf':
        return { 
          label: 'PDF', 
          badgeColor: 'bg-rose-50 text-rose-700 border-rose-200', 
          iconBg: 'bg-rose-100 text-rose-700',
          desc: 'PDF Document'
        };
      case 'doc':
        return { 
          label: 'DOC', 
          badgeColor: 'bg-blue-50 text-blue-700 border-blue-200', 
          iconBg: 'bg-blue-100 text-blue-700',
          desc: 'Word Document'
        };
      case 'ppt':
        return { 
          label: 'PPT', 
          badgeColor: 'bg-amber-50 text-amber-800 border-amber-200', 
          iconBg: 'bg-amber-100 text-amber-800',
          desc: 'PowerPoint Presentation'
        };
      case 'md':
        return { 
          label: 'MD', 
          badgeColor: 'bg-purple-50 text-purple-700 border-purple-200', 
          iconBg: 'bg-purple-100 text-purple-700',
          desc: 'Markdown File'
        };
      case 'txt':
        return { 
          label: 'TXT', 
          badgeColor: 'bg-slate-100 text-slate-700 border-slate-300', 
          iconBg: 'bg-slate-100 text-slate-700',
          desc: 'Plain Text File'
        };
      case 'arxiv':
        return { 
          label: 'arXiv', 
          badgeColor: 'bg-red-50 text-red-700 border-red-200', 
          iconBg: 'bg-red-100 text-red-700',
          desc: 'arXiv Academic Preprint'
        };
      case 'latex':
        return { 
          label: 'LaTeX', 
          badgeColor: 'bg-emerald-50 text-emerald-700 border-emerald-200', 
          iconBg: 'bg-emerald-100 text-emerald-700',
          desc: 'TeX / LaTeX Manuscript'
        };
      case 'bibtex':
        return { 
          label: 'BibTeX', 
          badgeColor: 'bg-amber-50 text-amber-800 border-amber-200', 
          iconBg: 'bg-amber-100 text-amber-700',
          desc: 'BibTeX Bibliography'
        };
      case 'slides':
        return { 
          label: 'Slides', 
          badgeColor: 'bg-sky-50 text-sky-700 border-sky-200', 
          iconBg: 'bg-sky-100 text-sky-700',
          desc: 'Lecture Presentation Deck'
        };
      case 'notes':
        return { 
          label: 'Notes', 
          badgeColor: 'bg-purple-50 text-purple-700 border-purple-200', 
          iconBg: 'bg-purple-100 text-purple-700',
          desc: 'Markdown / Raw Notes'
        };
      case 'book':
        return { 
          label: 'Book', 
          badgeColor: 'bg-indigo-50 text-indigo-700 border-indigo-200', 
          iconBg: 'bg-indigo-100 text-indigo-700',
          desc: 'Published Monograph'
        };
      case 'dataset':
        return { 
          label: 'Dataset', 
          badgeColor: 'bg-teal-50 text-teal-700 border-teal-200', 
          iconBg: 'bg-teal-100 text-teal-700',
          desc: 'Vector / Benchmark Dataset'
        };
      case 'url':
        return { 
          label: 'Web URL', 
          badgeColor: 'bg-blue-50 text-blue-700 border-blue-200', 
          iconBg: 'bg-blue-100 text-blue-700',
          desc: 'Web Documentation / DOI'
        };
      default:
        return { 
          label: (type as string).toUpperCase(), 
          badgeColor: 'bg-slate-50 text-slate-700 border-slate-200', 
          iconBg: 'bg-slate-100 text-slate-700',
          desc: 'Academic Document'
        };
    }
  };

  const handleCopyCitation = (source: IngestedSource) => {
    const key = source.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    navigator.clipboard.writeText(`\\cite{${key}}`);
    setCopiedId(source.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreateSource = () => {
    setIsIngesting(true);

    setTimeout(() => {
      let newSource: IngestedSource;

      if (ingestTab === 'arxiv') {
        const cleanId = arxivId.trim() || '2403.08741';
        newSource = {
          id: `src-${Date.now()}`,
          name: `arXiv_${cleanId}_Preprint.pdf`,
          size: '3.6 MB',
          type: 'arxiv',
          chunksCount: 94,
          uploadDate: new Date().toISOString().split('T')[0]!,
          status: 'indexed',
          authors: 'Research Author et al.',
          year: '2026',
          doi: `10.48550/arXiv.${cleanId}`,
          description: `arXiv academic preprint vector-indexed for RAG retrieval`,
        };
      } else if (ingestTab === 'bibtex') {
        newSource = {
          id: `src-${Date.now()}`,
          name: 'Bibliography_Entry.bib',
          size: '24 KB',
          type: 'bibtex',
          chunksCount: 16,
          uploadDate: new Date().toISOString().split('T')[0]!,
          status: 'indexed',
          authors: uploadAuthors || 'Specified in BibTeX',
          year: uploadYear || '2026',
          description: bibtexContent ? bibtexContent.slice(0, 100) : 'Parsed BibTeX citation record',
        };
      } else if (ingestTab === 'url') {
        newSource = {
          id: `src-${Date.now()}`,
          name: urlAddress.replace(/^https?:\/\//, '').split('/')[0] || 'Academic_Web_Resource',
          size: '1.8 MB',
          type: 'url',
          chunksCount: 56,
          uploadDate: new Date().toISOString().split('T')[0]!,
          status: 'indexed',
          url: urlAddress || 'https://arxiv.org',
          description: 'Web document parsed into vector chunks for agent retrieval',
        };
      } else {
        // File Upload
        const name = uploadFileName.trim() || 'Uploaded_Academic_Reference.pdf';
        newSource = {
          id: `src-${Date.now()}`,
          name: name,
          size: '3.4 MB',
          type: uploadFileType,
          chunksCount: 85,
          uploadDate: new Date().toISOString().split('T')[0]!,
          status: 'indexed',
          authors: uploadAuthors.trim() || undefined,
          year: uploadYear.trim() || undefined,
        };
      }

      onAddSource(newSource);
      setIsIngesting(false);
      setIsAddDrawerOpen(false);

      // Reset form
      setUploadFileName('');
      setArxivId('');
      setBibtexContent('');
      setUrlAddress('');
      setUploadAuthors('');
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs font-sans">
      <div className="bg-white border border-slate-200 rounded-2xl w-[80vw] h-[80vh] overflow-hidden shadow-2xl flex flex-col">
        {/* Modal Top Header */}
        <div className="p-4 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center shadow-xs">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900">
                  Project Sources & RAG Knowledge Base
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                  {currentBook.sources.length} Indexed
                </span>
              </div>
              <p className="text-xs text-slate-500 truncate max-w-md">
                Sources for: <span className="font-semibold text-slate-700">{currentBook.title}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsAddDrawerOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-colors shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Source</span>
            </button>

            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-800 rounded-lg hover:bg-slate-200/70 transition-colors ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Toolbar: Search, Filters & View Mode (Grid vs List) */}
        <div className="px-4 py-2.5 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs flex-shrink-0">
          {/* Search Box */}
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search reference papers, slides, or authors..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:bg-white focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Format Type Filters */}
          <div className="flex items-center gap-1 overflow-x-auto">
            {[
              { id: 'all', label: 'All Formats' },
              { id: 'pdf', label: 'PDF' },
              { id: 'doc', label: 'DOC' },
              { id: 'ppt', label: 'PPT' },
              { id: 'md', label: 'MD' },
              { id: 'txt', label: 'TXT' },
              { id: 'latex', label: 'LaTeX' },
              { id: 'bibtex', label: 'BibTeX' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setTypeFilter(tab.id)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                  typeFilter === tab.id
                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* View Mode Switcher: Grid vs List */}
          <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            <button
              onClick={() => setViewMode('grid')}
              title="Medium Icon Grid View"
              className={`p-1 rounded-md transition-colors ${
                viewMode === 'grid'
                  ? 'bg-white text-indigo-600 shadow-2xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              title="Detailed List View"
              className={`p-1 rounded-md transition-colors ${
                viewMode === 'list'
                  ? 'bg-white text-indigo-600 shadow-2xs font-bold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Content Body: Grid or List Explorer */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-slate-50/50">
          {filteredSources.length === 0 ? (
            <div className="p-12 text-center text-slate-400 space-y-3">
              <Database className="w-8 h-8 mx-auto text-slate-300" />
              <p className="text-sm font-semibold text-slate-600">No sources found</p>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                No indexed files matched your search. Click "Add Source" to upload reference PDFs, DOCs, PPTs, Markdown, or plain text files.
              </p>
              <button
                onClick={() => setIsAddDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Upload New Source</span>
              </button>
            </div>
          ) : viewMode === 'grid' ? (
            /* GRID VIEW with Medium-Sized Icon Per Supported Format */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredSources.map((source) => {
                const badge = getFormatBadge(source.type);
                const citCount = sourceCitationCounts[source.name] || 0;

                return (
                  <div
                    key={source.id}
                    className="bg-white border border-slate-200 hover:border-indigo-300 rounded-xl p-3.5 flex flex-col justify-between shadow-2xs hover:shadow-md transition-all group relative"
                  >
                    {/* Top Row: Format Icon, Title/Authors & Top Right Linked Citations */}
                    <div className="flex items-start justify-between gap-2.5">
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        {/* Medium Icon Container */}
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs uppercase shadow-2xs flex-shrink-0 ${badge.iconBg}`}>
                          {badge.label}
                        </div>

                        <div className="min-w-0 flex-1">
                          <h4 
                            className="font-bold text-xs text-slate-900 truncate group-hover:text-indigo-600 transition-colors"
                            title={source.name}
                          >
                            {source.name}
                          </h4>
                          {source.authors ? (
                            <p className="truncate text-[11px] text-slate-500 font-medium mt-0.5" title={source.authors}>
                              {source.authors} {source.year ? `(${source.year})` : ''}
                            </p>
                          ) : (
                            <p className="truncate text-[11px] text-slate-400 italic mt-0.5">
                              No authors listed
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Top Right: Number of linked citations (just icon and number with tooltip "Linked Citations") */}
                      <div 
                        title="Linked Citations" 
                        className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 bg-slate-50 border border-slate-200/80 px-2 py-0.5 rounded-md flex-shrink-0 cursor-default"
                      >
                        <Sparkles className="w-3 h-3 text-amber-500" />
                        <span>{citCount}</span>
                      </div>
                    </div>

                    {/* Footer: Left side: size, file status, spacer, delete button on right (Dense Layout) */}
                    <div className="pt-2 mt-2.5 border-t border-slate-100 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span className="font-mono text-slate-400">{source.size}</span>
                        <span className="w-1 h-1 rounded-full bg-slate-300" />
                        <span className="flex items-center gap-1 font-medium text-emerald-600">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                          Indexed
                        </span>
                      </div>

                      <button
                        type="button"
                        title="Delete Source"
                        onClick={() => onDeleteSource(source.id)}
                        className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* DETAILED LIST VIEW */
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F8FAFC] text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-4">Format</th>
                    <th className="py-2.5 px-4">Document / Source Name</th>
                    <th className="py-2.5 px-3">Authors / Year</th>
                    <th className="py-2.5 px-3">Size & Chunks</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSources.map((source) => {
                    const badge = getFormatBadge(source.type);
                    const citCount = sourceCitationCounts[source.name] || 0;

                    return (
                      <tr key={source.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[10px] uppercase ${badge.iconBg}`}>
                              {source.type}
                            </div>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border ${badge.badgeColor}`}>
                              {badge.label}
                            </span>
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900">{source.name}</div>
                          {source.description && (
                            <div className="text-[11px] text-slate-400 truncate max-w-xs">{source.description}</div>
                          )}
                        </td>

                        <td className="py-3 px-3 text-slate-600 font-medium">
                          {source.authors || '—'} {source.year ? `(${source.year})` : ''}
                        </td>

                        <td className="py-3 px-3 font-mono text-[11px] text-slate-500">
                          <div>{source.size}</div>
                          <div className="text-indigo-600 font-semibold">{source.chunksCount} chunks</div>
                        </td>

                        <td className="py-3 px-3">
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            Indexed ({citCount} cites)
                          </span>
                        </td>

                        <td className="py-3 px-3 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              title="Copy Citation"
                              onClick={() => handleCopyCitation(source)}
                              className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-md transition-colors"
                            >
                              {copiedId === source.id ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>

                            <button
                              type="button"
                              title="Delete Source"
                              onClick={() => onDeleteSource(source.id)}
                              className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Add Source Slide-over Drawer / Modal Sub-panel */}
        {isAddDrawerOpen && (
          <div className="p-5 bg-white border-t-2 border-indigo-500 shadow-xl space-y-4 animate-in slide-in-from-bottom-2 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-indigo-600" />
                <h3 className="font-bold text-sm text-slate-900">Add New Reference Source</h3>
              </div>

              {/* Ingest Method Tabs */}
              <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg text-xs">
                {[
                  { id: 'upload', label: 'File Upload' },
                  { id: 'arxiv', label: 'arXiv Import' },
                  { id: 'bibtex', label: 'BibTeX' },
                  { id: 'url', label: 'Web URL / DOI' },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setIngestTab(t.id as IngestTab)}
                    className={`px-3 py-1 rounded-md font-semibold transition-colors ${
                      ingestTab === t.id
                        ? 'bg-white text-indigo-600 shadow-2xs font-bold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setIsAddDrawerOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Ingest Form Inputs based on Tab */}
            {ingestTab === 'upload' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Source Document Name / File</label>
                  <input
                    type="text"
                    placeholder="e.g. NonEquilibrium_FieldTheory_Notes.pdf"
                    value={uploadFileName}
                    onChange={(e) => setUploadFileName(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Document Type</label>
                  <select
                    value={uploadFileType}
                    onChange={(e) => setUploadFileType(e.target.value as any)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="pdf">PDF Document (.pdf)</option>
                    <option value="doc">Word Document (.docx / .doc)</option>
                    <option value="ppt">PowerPoint Presentation (.pptx / .ppt)</option>
                    <option value="md">Markdown File (.md)</option>
                    <option value="txt">Plain Text File (.txt)</option>
                    <option value="latex">LaTeX Manuscript (.tex)</option>
                    <option value="bibtex">BibTeX Citations (.bib)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Authors & Year (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. Prof. Vance et al., 2026"
                    value={uploadAuthors}
                    onChange={(e) => setUploadAuthors(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>
            )}

            {ingestTab === 'arxiv' && (
              <div className="space-y-2 text-xs">
                <label className="font-bold text-slate-700">arXiv ID or Search Query</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g. 2104.13478 or 2403.08741"
                    value={arxivId}
                    onChange={(e) => setArxivId(e.target.value)}
                    className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="text-slate-400 font-mono text-[11px]">https://arxiv.org/abs/...</span>
                </div>
              </div>
            )}

            {ingestTab === 'bibtex' && (
              <div className="space-y-2 text-xs">
                <label className="font-bold text-slate-700">Raw BibTeX Entry</label>
                <textarea
                  rows={3}
                  placeholder={`@article{lamport1982byzantine,\n  author = {Leslie Lamport and Robert Shostak},\n  title = {The Byzantine Generals Problem},\n  journal = {ACM TOPLAS},\n  year = {1982}\n}`}
                  value={bibtexContent}
                  onChange={(e) => setBibtexContent(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 font-mono text-[11px] text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            )}

            {ingestTab === 'url' && (
              <div className="space-y-2 text-xs">
                <label className="font-bold text-slate-700">Web Document URL or DOI</label>
                <input
                  type="text"
                  placeholder="e.g. https://doi.org/10.1145/357172.357176"
                  value={urlAddress}
                  onChange={(e) => setUrlAddress(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            )}

            {/* Ingestion Submit Action */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsAddDrawerOpen(false)}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={isIngesting}
                onClick={handleCreateSource}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs transition-colors"
              >
                {isIngesting ? (
                  <>
                    <Sparkles className="w-3.5 h-3.5 animate-spin" />
                    <span>Chunking & Vectorizing...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Index into RAG Vector Store</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
