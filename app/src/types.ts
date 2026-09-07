export type UIVariant = 'structured-architect' | 'canvas-graph' | 'manuscript-press';

export type NodeStatus = 'not_started' | 'drafting' | 'review_ready' | 'compiled';

export type AudienceLevel = 'undergraduate' | 'graduate' | 'phd_researcher' | 'industry_practitioner';

export interface RAGCitation {
  id: string;
  sourceDoc: string;
  pageNumber?: number;
  sectionSnippet: string;
  relevanceScore: number;
  authorYear?: string;
}

export interface OutlineNode {
  id: string;
  title: string;
  sectionNumber: string; // e.g. "1.2.1"
  level: number; // 1 = Chapter, 2 = Section, 3 = Subsection
  status: NodeStatus;
  targetPages: number;
  wordBudget: number;
  actualWords: number;
  equationDensityLevel: number; // 1 to 5
  mathLevel: 'introductory' | 'rigorous' | 'formal_proof' | 'applied';
  subPrompt?: string;
  contentMarkdown: string;
  contentLatex: string;
  ragCitations: RAGCitation[];
  reviewerScore?: number;
  reviewerNotes?: string;
  children?: OutlineNode[];
}

export type SourceType = 'pdf' | 'doc' | 'ppt' | 'md' | 'txt' | 'slides' | 'arxiv' | 'notes' | 'bibtex' | 'latex' | 'url' | 'book' | 'dataset';

export interface IngestedSource {
  id: string;
  name: string;
  size: string;
  type: SourceType;
  chunksCount: number;
  uploadDate: string;
  status: 'indexed' | 'indexing' | 'error';
  authors?: string;
  year?: string;
  doi?: string;
  url?: string;
  description?: string;
}

export interface BookProject {
  id: string;
  title: string;
  subtitle: string;
  authors: string[];
  topic: string;
  targetAudience: AudienceLevel;
  totalPagesBudget: number;
  equationFrequencyLevel: number; // 1 to 5
  doConsiderOutline: boolean;
  doConsiderPreviousSections: boolean;
  outputFormat: 'latex' | 'markdown' | 'pdf';
  maxOutlineLevels?: number; // 1 to 5, default 3
  sources: IngestedSource[];
  outline: OutlineNode[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentStreamLog {
  id: string;
  timestamp: string;
  agentName: 'Planner Agent' | 'Writer Agent' | 'Math Formalizer' | 'Reviewer Agent' | 'RAG Retriever';
  agentColor: string;
  status: 'active' | 'completed' | 'queued' | 'error';
  thought: string;
  tokensGenerated?: number;
  currentStep: string;
}

export interface StreamState {
  isStreaming: boolean;
  activeAgent: string | null;
  activeNodeId: string | null;
  tokenBuffer: string;
  thoughtTrace: string[];
  logs: AgentStreamLog[];
}
