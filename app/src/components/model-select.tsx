import { useId } from 'react';

import { useModels } from '@/api/queries/system';
import { Input } from '@/components/ui/input';

interface ModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A model picker fed by `GET /system/models` (issue #128) — a plain text `Input` backed by a
 * native `<datalist>` of the discovered model ids rather than a shadcn `Select`/`Combobox`:
 * the discovery list can run to hundreds of entries (a full OpenRouter catalog), which a
 * `<select>`-style dropdown handles poorly, while `<datalist>` gives free-text entry,
 * type-to-filter, and a dropdown of suggestions for free. This also satisfies both fallback
 * requirements at once, with no extra branching: the current value always renders (it's just
 * the input's value, in or out of the list) and an empty discovery list degrades to a plain
 * text input on its own (an empty `<datalist>` is a no-op).
 */
export function ModelSelect({ value, onChange, id, placeholder, disabled }: ModelSelectProps) {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-models`;
  const { data } = useModels();
  const models = data?.items ?? [];

  return (
    <>
      <Input
        id={id}
        list={models.length > 0 ? listId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? 'e.g. openai/gpt-5-mini'}
        disabled={disabled}
        autoComplete="off"
      />
      {models.length > 0 ? (
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name ?? model.id}
            </option>
          ))}
        </datalist>
      ) : null}
    </>
  );
}
