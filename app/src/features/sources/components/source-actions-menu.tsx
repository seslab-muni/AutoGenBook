import { Copy, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import type { Source } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { suggestCiteKey } from '@/features/sources/lib/source-format';

interface SourceActionsMenuProps {
  source: Source;
  onEdit: () => void;
  onDetach: () => void;
}

export function SourceActionsMenu({ source, onEdit, onDetach }: SourceActionsMenuProps) {
  function handleCopyCiteKey() {
    const key = suggestCiteKey(source.name);
    void navigator.clipboard.writeText(`\\cite{${key}}`).then(() => {
      toast.success('Copied \\cite{} key', {
        description:
          'A suggested key — the run assigns the real citation key once it indexes this source.',
      });
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`${source.name} actions`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit metadata
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleCopyCiteKey}>
          <Copy />
          Copy \cite{'{}'} key
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDetach}>
          <Trash2 />
          Detach
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
