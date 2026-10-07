import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface HeaderIconButtonProps {
  label: string;
  tooltip: string;
  disabled?: boolean;
  pressed?: boolean | undefined;
  onClick?: (() => void) | undefined;
  children: React.ReactNode;
}

/**
 * An icon-only button in the editor header with a tooltip. A disabled button gets no pointer
 * events, so the tooltip hangs off a focusable wrapper span instead — that keeps the reason it
 * is disabled reachable by hover and by keyboard.
 */
export function HeaderIconButton({
  label,
  tooltip,
  disabled = false,
  pressed,
  onClick,
  children,
}: HeaderIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={disabled ? 0 : undefined}>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
