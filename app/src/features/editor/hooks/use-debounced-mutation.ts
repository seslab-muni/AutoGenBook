import { useCallback, useEffect, useRef, useState } from 'react';

import type { SaveStatus } from '@/features/editor/lib/save-status';

interface UseDebouncedMutationOptions<T> {
  /** Debounce delay, in ms — 800 per the editor's autosave spec. */
  delayMs?: number;
  /** Persists `value`; a resolved promise is a success, a rejection an error. */
  onSave: (value: T) => Promise<unknown>;
}

interface UseDebouncedMutationResult<T> {
  status: SaveStatus;
  /** Marks `value` dirty and (re)starts the debounce timer from now. */
  schedule: (value: T) => void;
  /** Cancels any pending timer and saves immediately if a value is pending. */
  flush: () => void;
  /**
   * While held, nothing is saved (timers and `flush` do nothing) and the pending value stays pending
   * (status stays `dirty`): used while the user has to decide between their edits and an incoming
   * change from elsewhere, so an autosave cannot make the decision for them. Holds are kept per
   * `reason` (default `'default'`): saving resumes only when every reason has released its hold, so
   * an accept in flight and a pending conflict notice cannot lift each other's.
   */
  hold: (held: boolean, reason?: string) => void;
  /**
   * Saves what is pending and resolves once nothing is pending or in flight (also when nothing was).
   * Rejects if a save fails, or if saving is held.
   */
  flushEdits: () => Promise<void>;
  /**
   * Drops a value that is waiting to be saved (its timer included); one already in flight finishes.
   * A failed save's error state goes with it (the caller has decided what happens to that text).
   */
  cancel: () => void;
}

/**
 * Debounced "save this value" helper backing `SectionEditor`'s autosave:
 * `schedule` resets an 800ms timer on every call (so a burst of keystrokes
 * yields exactly one save, `delayMs` after the last one), `flush` saves
 * immediately (for blur/route-change/`Ctrl+S`/unmount). If `schedule` is
 * called again while a save is already in flight, the newest value is saved
 * right after the current one resolves rather than being dropped.
 */
export function useDebouncedMutation<T>({
  delayMs = 800,
  onSave,
}: UseDebouncedMutationOptions<T>): UseDebouncedMutationResult<T> {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ value: T } | null>(null);
  const savingRef = useRef(false);
  const heldRef = useRef(new Set<string>());
  const waitersRef = useRef<{ resolve: () => void; reject: (error: unknown) => void }[]>([]);

  // Latest `onSave`/`save` behind refs, updated in an effect rather than during
  // render: `save` recurses (a value scheduled mid-flight saves right after),
  // which needs a stable way to call "whatever `save` currently is" without
  // referencing the `const save` binding from inside its own initializer.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const saveRef = useRef<() => void>(() => {});

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const save = useCallback(() => {
    if (heldRef.current.size > 0 || savingRef.current || pendingRef.current === null) return;
    const { value } = pendingRef.current;
    pendingRef.current = null;
    savingRef.current = true;
    setStatus('saving');
    onSaveRef
      .current(value)
      .then(() => {
        savingRef.current = false;
        if (pendingRef.current !== null) {
          saveRef.current();
        } else {
          setStatus('saved');
          for (const waiter of waitersRef.current.splice(0)) waiter.resolve();
        }
      })
      .catch((error: unknown) => {
        savingRef.current = false;
        setStatus('error');
        for (const waiter of waitersRef.current.splice(0)) waiter.reject(error);
      });
  }, []);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const schedule = useCallback(
    (value: T) => {
      pendingRef.current = { value };
      setStatus('dirty');
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        save();
      }, delayMs);
    },
    [clearTimer, delayMs, save],
  );

  const flush = useCallback(() => {
    clearTimer();
    save();
  }, [clearTimer, save]);

  const hold = useCallback((held: boolean, reason = 'default') => {
    if (held) heldRef.current.add(reason);
    else heldRef.current.delete(reason);
  }, []);

  const flushEdits = useCallback(() => {
    if (heldRef.current.size > 0 && pendingRef.current !== null) {
      return Promise.reject(
        new Error('Saving is on hold until the conflicting change is resolved.'),
      );
    }
    if (!savingRef.current && pendingRef.current === null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waitersRef.current.push({ resolve, reject });
      clearTimer();
      save();
    });
  }, [clearTimer, save]);

  const cancel = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
    setStatus((current) => (current === 'dirty' || current === 'error' ? 'saved' : current));
    if (!savingRef.current) for (const waiter of waitersRef.current.splice(0)) waiter.resolve();
  }, [clearTimer]);

  // Cancel any in-flight timer on unmount — a caller that wants to persist
  // last-second edits should call `flush()` itself before unmounting.
  useEffect(() => clearTimer, [clearTimer]);

  return { status, schedule, flush, cancel, hold, flushEdits };
}
