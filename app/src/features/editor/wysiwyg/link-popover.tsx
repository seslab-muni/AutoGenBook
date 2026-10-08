import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { isSafeHref } from './safe-href';

export interface LinkRequest {
  /** The address the link has now, if the caret is in one. */
  current: string | null;
  /** Client coordinates of the selection: the popover opens just below. */
  x: number;
  y: number;
  /** Settles the request: the address, `''` to remove the link, `null` for cancel. */
  resolve: (value: string | null) => void;
}

/**
 * The link address prompt (Ctrl/Cmd+K): a small form next to the selection instead of the
 * browser's `prompt()`. Enter applies, Escape cancels, an address that is not `http(s):`, `mailto:`,
 * relative or `#` is explained and kept open; focus goes to the address on open and back to the
 * editor on close (the caller focuses the editor).
 */
export function LinkPopover({ request }: { request: LinkRequest }) {
  const [value, setValue] = useState(request.current ?? 'https://');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const apply = () => {
    const href = value.trim();
    if (href !== '' && !isSafeHref(href)) {
      setError('Use an http(s) or mailto: address, a relative address, or one starting with #.');
      return;
    }
    request.resolve(href);
  };

  return (
    <form
      role="dialog"
      aria-label="Link address"
      className="fixed z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-md border bg-popover p-3 font-sans text-popover-foreground shadow-md"
      style={{
        left: Math.max(8, Math.min(request.x, window.innerWidth - 336)),
        top: request.y + 8,
      }}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          request.resolve(null);
        }
      }}
    >
      <label className="text-xs font-medium" htmlFor="md-link-address">
        Link address
      </label>
      <Input
        id="md-link-address"
        ref={input}
        value={value}
        inputMode="url"
        spellCheck={false}
        aria-invalid={error !== null}
        aria-describedby={error ? 'md-link-error' : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
      />
      {error ? (
        <p id="md-link-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {request.current !== null ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => request.resolve('')}>
            Remove link
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="outline" onClick={() => request.resolve(null)}>
          Cancel
        </Button>
        <Button type="submit" size="xs">
          Apply
        </Button>
      </div>
    </form>
  );
}
