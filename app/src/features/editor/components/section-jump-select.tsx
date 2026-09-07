import type { OutlineNode } from '@/api/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { assignPositions } from '@/features/outline/model';

interface SectionJumpSelectProps {
  flat: readonly OutlineNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

/**
 * Flattened, numbered section picker for the centre pane's toolbar — shown
 * only while the outline pane is closed, so there's still a way to switch
 * sections without reopening it (mirrors `_reference/components/editor/StageEditor.tsx`'s
 * chapter dropdown).
 */
export function SectionJumpSelect({ flat, selectedNodeId, onSelectNode }: SectionJumpSelectProps) {
  const positioned = assignPositions(flat)
    .slice()
    .sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber, undefined, { numeric: true }));

  if (positioned.length === 0) return null;

  return (
    <Select {...(selectedNodeId ? { value: selectedNodeId } : {})} onValueChange={onSelectNode}>
      <SelectTrigger
        size="sm"
        className="max-w-[220px] sm:max-w-[320px]"
        aria-label="Jump to section"
      >
        <SelectValue placeholder="Jump to section…" />
      </SelectTrigger>
      <SelectContent>
        {positioned.map((node) => (
          <SelectItem key={node.id} value={node.id}>
            <span className="truncate">
              {' '.repeat((node.level - 1) * 2)}§{node.sectionNumber} {node.title}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
