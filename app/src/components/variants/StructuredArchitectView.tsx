import React from 'react';
import { OutlineNode, AgentStreamLog } from '../../types';
import { OutlineTree } from '../tree/OutlineTree';
import { StageEditor } from '../editor/StageEditor';
import { AgentStreamDrawer } from '../agent/AgentStreamDrawer';

interface StructuredArchitectViewProps {
  nodes: OutlineNode[];
  selectedNode: OutlineNode | null;
  onSelectNode: (node: OutlineNode) => void;
  onAddChildNode: (parentNodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onRenameNode?: (nodeId: string, newTitle: string) => void;
  onGenerateNode: (node: OutlineNode) => void;
  onUpdateContent: (nodeId: string, markdown: string) => void;
  onTriggerNodeGeneration: (promptModifier?: string) => void;
  onUpdateNodeMathLevel: (mathLevel: OutlineNode['mathLevel']) => void;
  onUpdateNodeEquationDensity: (density: number) => void;
  onUpdateNodeBudget?: (targetPages: number, wordBudget: number) => void;
  isStreaming: boolean;
  logs: AgentStreamLog[];
  tokenBuffer: string;
  thoughtTrace: string[];
  maxLevels?: number;
  isOutlineOpen: boolean;
  onToggleOutline: () => void;
  isAgentOpen: boolean;
  onToggleAgent: () => void;
}

export const StructuredArchitectView: React.FC<StructuredArchitectViewProps> = ({
  nodes,
  selectedNode,
  onSelectNode,
  onAddChildNode,
  onDeleteNode,
  onRenameNode,
  onGenerateNode,
  onUpdateContent,
  onTriggerNodeGeneration,
  onUpdateNodeMathLevel,
  onUpdateNodeEquationDensity,
  onUpdateNodeBudget,
  isStreaming,
  logs,
  tokenBuffer,
  thoughtTrace,
  maxLevels = 3,
  isOutlineOpen,
  onToggleOutline,
  isAgentOpen,
  onToggleAgent,
}) => {
  return (
    <div className="flex-1 flex overflow-hidden h-full w-full min-h-0">
      {/* Left Column: Outline Explorer Tree */}
      {isOutlineOpen && (
        <div className="w-72 lg:w-80 h-full flex-shrink-0 overflow-hidden animate-in slide-in-from-left duration-150">
          <OutlineTree
            nodes={nodes}
            selectedNodeId={selectedNode?.id || null}
            onSelectNode={onSelectNode}
            onAddChildNode={onAddChildNode}
            onDeleteNode={onDeleteNode}
            onRenameNode={onRenameNode}
            onGenerateNode={onGenerateNode}
            onTriggerNodeGeneration={onTriggerNodeGeneration}
            isStreaming={isStreaming}
            maxLevels={maxLevels}
            onToggleClose={onToggleOutline}
          />
        </div>
      )}

      {/* Center Column: Stage Editor (Expands when left/right panes are closed) */}
      <div className="flex-1 h-full min-w-0 overflow-hidden">
        <StageEditor
          nodes={nodes}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
          onUpdateContent={onUpdateContent}
          onTriggerContextualPrompt={onTriggerNodeGeneration}
          isStreaming={isStreaming}
          isOutlineOpen={isOutlineOpen}
          onToggleOutline={onToggleOutline}
          isAgentOpen={isAgentOpen}
          onToggleAgent={onToggleAgent}
        />
      </div>

      {/* Right Column: Multi-Agent Stream Drawer & Citations */}
      {isAgentOpen && (
        <div className="w-80 lg:w-96 h-full flex-shrink-0 overflow-hidden animate-in slide-in-from-right duration-150">
          <AgentStreamDrawer
            selectedNode={selectedNode}
            isStreaming={isStreaming}
            logs={logs}
            tokenBuffer={tokenBuffer}
            thoughtTrace={thoughtTrace}
            onTriggerNodeGeneration={onTriggerNodeGeneration}
            onUpdateNodeMathLevel={onUpdateNodeMathLevel}
            onUpdateNodeEquationDensity={onUpdateNodeEquationDensity}
            onUpdateNodeBudget={onUpdateNodeBudget}
            onToggleClose={onToggleAgent}
          />
        </div>
      )}
    </div>
  );
};
