import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useReplaceOutlineMutation } from '@/api/queries/outline';
import { ApiError } from '@/api/client';
import type { OutlineTreeReplace, OutlineTreeReplaceNode } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { parseOutlineText, type ParsedOutlineNode } from '@/features/outline/parse-outline-text';

interface DraftNode {
  key: string;
  title: string;
  children: DraftNode[];
}

function newNode(title = ''): DraftNode {
  return { key: crypto.randomUUID(), title, children: [] };
}

function fromParsedNodes(nodes: readonly ParsedOutlineNode[]): DraftNode[] {
  return nodes.map((node) => ({
    key: crypto.randomUUID(),
    title: node.title,
    children: fromParsedNodes(node.children),
  }));
}

function toReplaceNodes(nodes: readonly DraftNode[]): OutlineTreeReplace {
  return nodes
    .filter((node) => node.title.trim().length > 0)
    .map(
      (node): OutlineTreeReplaceNode => ({
        title: node.title.trim(),
        children: toReplaceNodes(node.children),
      }),
    );
}

function updateNode(
  nodes: readonly DraftNode[],
  key: string,
  update: (node: DraftNode) => DraftNode,
): DraftNode[] {
  return nodes.map((node) =>
    node.key === key ? update(node) : { ...node, children: updateNode(node.children, key, update) },
  );
}

function removeNode(nodes: readonly DraftNode[], key: string): DraftNode[] {
  return nodes
    .filter((node) => node.key !== key)
    .map((node) => ({ ...node, children: removeNode(node.children, key) }));
}

function addChild(nodes: readonly DraftNode[], parentKey: string): DraftNode[] {
  return nodes.map((node) =>
    node.key === parentKey
      ? { ...node, children: [...node.children, newNode()] }
      : { ...node, children: addChild(node.children, parentKey) },
  );
}

interface DraftRowProps {
  node: DraftNode;
  depth: number;
  maxDepth: number;
  onChange: (nodes: DraftNode[]) => void;
  nodes: DraftNode[];
}

function DraftRow({ node, depth, maxDepth, onChange, nodes }: DraftRowProps) {
  return (
    <div>
      <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: `${depth * 20}px` }}>
        <Input
          value={node.title}
          placeholder={depth === 0 ? 'Chapter title' : 'Section title'}
          className="h-8"
          onChange={(event) =>
            onChange(updateNode(nodes, node.key, (n) => ({ ...n, title: event.target.value })))
          }
        />
        {depth < maxDepth - 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Add sub-section"
            onClick={() => onChange(addChild(nodes, node.key))}
          >
            <Plus className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Remove"
          onClick={() => onChange(removeNode(nodes, node.key))}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {node.children.map((child) => (
        <DraftRow
          key={child.key}
          node={child}
          depth={depth + 1}
          maxDepth={maxDepth}
          nodes={nodes}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

interface OutlineDraftEditorProps {
  projectId: string;
  maxOutlineLevels: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Standalone "author outline yourself" tree editor over local state,
 * producing an `OutlineTreeReplace` sent via `PUT /outline`. Reachable only
 * from the empty-outline-pane state in this pass — not wired into the
 * new-project wizard (#17 already shipped without this step; integrating it
 * there is future work).
 */
export function OutlineDraftEditor({
  projectId,
  maxOutlineLevels,
  open,
  onOpenChange,
}: OutlineDraftEditorProps) {
  const [nodes, setNodes] = useState<DraftNode[]>([newNode()]);
  const [pasteText, setPasteText] = useState('');
  const replaceMutation = useReplaceOutlineMutation(projectId);

  function handleParse() {
    const parsed = parseOutlineText(pasteText, maxOutlineLevels);
    if (parsed.length === 0) {
      toast.error('Could not find any chapter titles in the pasted text');
      return;
    }
    setNodes(fromParsedNodes(parsed));
    setPasteText('');
  }

  function handleSave() {
    const body = toReplaceNodes(nodes);
    if (body.length === 0) {
      toast.error('Add at least one chapter title');
      return;
    }
    replaceMutation.mutate(body, {
      onSuccess: () => {
        toast.success('Outline saved');
        onOpenChange(false);
        setNodes([newNode()]);
      },
      onError: (error) => {
        const title = error instanceof ApiError ? error.problem?.title : undefined;
        toast.error(title ?? 'Could not save outline');
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="custom-scrollbar max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Author outline</DialogTitle>
          <DialogDescription>
            Type chapter and section titles directly, or paste a list below. This replaces the
            entire outline.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={
              'Paste a plain list, a numbered list (1. / 1.1 / 1.1.1), or Markdown headings ' +
              '(#, ##, ###) — nesting is detected automatically.'
            }
            className="min-h-24"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={handleParse}
            disabled={pasteText.trim().length === 0}
          >
            Parse into outline
          </Button>
        </div>

        <div className="space-y-1">
          {nodes.map((node) => (
            <DraftRow
              key={node.key}
              node={node}
              depth={0}
              maxDepth={maxOutlineLevels}
              nodes={nodes}
              onChange={setNodes}
            />
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => setNodes([...nodes, newNode()])}
        >
          <Plus className="size-3.5" />
          Add chapter
        </Button>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={replaceMutation.isPending}>
            Save outline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
