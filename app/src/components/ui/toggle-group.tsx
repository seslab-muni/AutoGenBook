import * as React from "react"
import { cn } from "@/lib/utils"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

/**
 * Single-select segmented toggle (Radix `ToggleGroup`): a labelled group of `radio` items with
 * roving focus. Unlike `Tabs` it owns no panels, so nothing dangles an `aria-controls`.
 */
function ToggleGroup({
  className,
  value,
  onValueChange,
  ...props
}: Omit<
  React.ComponentProps<typeof ToggleGroupPrimitive.Root>,
  "type" | "value" | "onValueChange" | "defaultValue"
> & { value: string; onValueChange: (value: string) => void }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      type="single"
      value={value}
      // Radix reports "" when the active item is clicked again; a segmented control never unsets.
      onValueChange={(next) => {
        if (next) onValueChange(next)
      }}
      className={cn("inline-flex h-8 items-center rounded-lg bg-muted p-[3px]", className)}
      {...props}
    />
  )
}

function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-full items-center justify-center rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
