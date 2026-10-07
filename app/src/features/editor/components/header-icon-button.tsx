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
 * An icon-only button in the editor header with a tooltip. "Disabled" is `aria-disabled`, not the
 * `disabled` attribute: the button stays focusable and hoverable, so the tooltip that says why it
 * does nothing is reachable by keyboard and pointer, while a click is a no-op.
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
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          aria-disabled={disabled || undefined}
          className={disabled ? 'cursor-not-allowed opacity-50' : undefined}
          onClick={disabled ? undefined : onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
