import * as React from "react"
import { cn } from "@/lib/utils"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

const SelectOnFocusContext = React.createContext<((value: string) => void) | null>(null)

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
    <SelectOnFocusContext.Provider value={onValueChange}>
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
    </SelectOnFocusContext.Provider>
  )
}

function ToggleGroupItem({
  className,
  onFocus,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  const select = React.useContext(SelectOnFocusContext)
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      // Radio pattern: arrow keys move focus *and* select, so focus selects the item.
      onFocus={(event) => {
        onFocus?.(event)
        select?.(props.value)
      }}
      className={cn(
        "inline-flex h-full items-center justify-center rounded-md px-1.5 @md:px-2 text-sm font-medium whitespace-nowrap text-foreground transition-colors hover:bg-background/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
