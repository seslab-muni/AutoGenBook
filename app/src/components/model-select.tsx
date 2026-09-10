import { memo, useId, useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { useModels } from '@/api/queries/system';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface ModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A model picker fed by `GET /system/models` (issue #128) — a free-solo `Command`/`Popover`
 * combobox (search-to-filter, a chevron trigger matching the other dropdown fields) rather than
 * a shadcn `Select`: the discovery list can run to hundreds of entries (a full OpenRouter
 * catalog), which a `<select>`-style dropdown handles poorly, so the search box both filters the
 * suggestions and *is* the field's value — a string with no match in the catalog (a custom
 * deployment's model id) is still typed and saved as-is, it just shows no suggestions. This also
 * satisfies both fallback requirements at once, with no extra branching: the current value
 * always renders (it's just the input's value) and an empty discovery list degrades to a plain
 * search box with no suggestions, which is still a normal usable text field.
 *
 * Wrapped in `memo` (issue #128 review): mounted inside forms like `ProjectFormFields`, where
 * every keystroke in an unrelated field (title, topic, ...) re-renders the whole field list.
 * Without this, that also re-ran `useModels()` and rebuilt every item in a hundreds-of-entries
 * catalog on each keystroke, which is what made `new-project-dialog.test.tsx` slow enough to
 * time out. `memo` only pays off when the props below stay referentially stable, so callers must
 * not pass inline object/array literals or freshly-created callbacks - see `ProjectFormFields`'s
 * own `useCallback`-wrapped handler.
 */
export const ModelSelect = memo(function ModelSelect({
  value,
  onChange,
  id,
  placeholder,
  disabled,
}: ModelSelectProps) {
  const generatedId = useId();
  const [open, setOpen] = useState(false);
  const { data } = useModels();
  const models = useMemo(() => data?.items ?? [], [data]);
  const resolvedPlaceholder = placeholder ?? 'e.g. openai/gpt-5-mini';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id ?? generatedId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || resolvedPlaceholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
        <Command shouldFilter={models.length > 0}>
          <CommandInput value={value} onValueChange={onChange} placeholder={resolvedPlaceholder} />
          <CommandList>
            {models.length > 0 ? (
              <>
                <CommandEmpty>No matching model — your text is still used as typed.</CommandEmpty>
                <CommandGroup>
                  {models.map((model) => (
                    <CommandItem
                      key={model.id}
                      value={model.id}
                      onSelect={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                    >
                      <Check className={cn('size-4', model.id === value ? 'opacity-100' : 'opacity-0')} />
                      {model.name ?? model.id}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});
