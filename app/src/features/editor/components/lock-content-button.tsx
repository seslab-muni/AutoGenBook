import { Lock, LockOpen } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import type { OutlineNode } from '@/api/types';
import { HeaderIconButton } from '@/features/editor/components/header-icon-button';
import { contentLockDisabledReason } from '@/features/outline/content-lock';

interface LockContentButtonProps {
  projectId: string;
  node: OutlineNode;
  flat: readonly OutlineNode[];
}

/**
 * The editor header's content-lock toggle (issue #113): a locked section is kept byte-for-byte
 * by full runs. Same enablement rules as the outline row's toggle (`contentLockDisabledReason`).
 */
export function LockContentButton({ projectId, node, flat }: LockContentButtonProps) {
  const updateMutation = useUpdateOutlineNodeMutation(projectId, node.id);
  const disabledReason = contentLockDisabledReason(node, flat);

  let tooltip = 'Lock content: keep as-is on full runs';
  if (node.contentLocked) tooltip = 'Content locked: kept as-is on full runs. Click to unlock.';
  else if (disabledReason) tooltip = disabledReason;

  return (
    <HeaderIconButton
      label="Lock content"
      tooltip={tooltip}
      pressed={node.contentLocked}
      disabled={Boolean(disabledReason)}
      onClick={() =>
        updateMutation.mutate(
          { contentLocked: !node.contentLocked },
          {
            onError: (error) => {
              const problem = error instanceof ApiError ? error.problem : undefined;
              toast.error(problem?.detail ?? problem?.title ?? 'Could not change the content lock');
            },
          },
        )
      }
    >
      {node.contentLocked ? <Lock /> : <LockOpen />}
    </HeaderIconButton>
  );
}
