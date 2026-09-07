import type { OutlineNode } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { descendantIds } from '@/features/outline/model';

interface DeleteNodeDialogProps {
  node: OutlineNode | null;
  flat: readonly OutlineNode[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (nodeId: string) => void;
}

/** Confirmation for deleting a node and its whole subtree, built on the shared `ConfirmDialog`. */
export function DeleteNodeDialog({ node, flat, onOpenChange, onConfirm }: DeleteNodeDialogProps) {
  const descendantCount = node ? descendantIds(node.id, flat).size : 0;
  const kind = node && node.level <= 1 ? 'chapter' : 'section';

  return (
    <ConfirmDialog
      open={node !== null}
      onOpenChange={onOpenChange}
      title={node ? `Delete "${node.title}"?` : 'Delete section?'}
      description={
        descendantCount > 0
          ? `This ${kind} includes ${descendantCount} nested section${descendantCount === 1 ? '' : 's'}. Deleting it removes the entire branch, including all drafted content. This cannot be undone.`
          : `All drafted content for this ${kind} will be permanently deleted. This cannot be undone.`
      }
      confirmLabel="Delete"
      tone="destructive"
      onConfirm={() => {
        if (node) onConfirm(node.id);
      }}
    />
  );
}
