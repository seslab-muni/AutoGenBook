import { useEffect, useRef } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedMutation } from './use-debounced-mutation';

describe('useDebouncedMutation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of `schedule` calls into exactly one save after the debounce window', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useDebouncedMutation<string>({ delayMs: 800, onSave }));

    act(() => result.current.schedule('a'));
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current.schedule('ab'));
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current.schedule('abc'));
    expect(result.current.status).toBe('dirty');
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('abc');
    expect(result.current.status).toBe('saved');
  });

  it('flush() saves immediately and cancels the pending timer', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useDebouncedMutation<string>({ delayMs: 800, onSave }));

    act(() => result.current.schedule('draft'));
    await act(async () => {
      result.current.flush();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('draft');

    // The debounce timer that would have fired at +800ms was cancelled by flush().
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('saves a value scheduled during an in-flight save right after it resolves, rather than dropping it', async () => {
    let resolveFirst!: () => void;
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useDebouncedMutation<string>({ delayMs: 800, onSave }));

    act(() => result.current.schedule('first'));
    await act(async () => {
      result.current.flush();
    });
    expect(result.current.status).toBe('saving');

    // A new edit arrives while the first save is still in flight.
    act(() => result.current.schedule('second'));

    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenNthCalledWith(1, 'first');
    expect(onSave).toHaveBeenNthCalledWith(2, 'second');
    expect(result.current.status).toBe('saved');
  });

  it('reports an error status when the save rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useDebouncedMutation<string>({ delayMs: 800, onSave }));

    act(() => result.current.schedule('draft'));
    await act(async () => {
      result.current.flush();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('error');
  });

  it('flushes a pending edit on unmount (the pattern `ManuscriptSheet` uses)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    // Mirrors `ManuscriptSheet`: a ref kept up to date with the latest `flush` (in its own
    // effect, so the ref is never mutated during render), called from an unmount-only effect
    // cleanup — so unmounting mid-debounce still persists the last edit.
    function Harness() {
      const { schedule, flush } = useDebouncedMutation<string>({ delayMs: 800, onSave });
      const flushRef = useRef(flush);
      useEffect(() => {
        flushRef.current = flush;
      }, [flush]);
      useEffect(() => () => flushRef.current(), []);

      useEffect(() => {
        schedule('unsaved edit');
        // eslint-disable-next-line react-hooks/exhaustive-deps -- schedule once, on mount
      }, []);
      return null;
    }

    const { unmount } = render(<Harness />);
    expect(onSave).not.toHaveBeenCalled();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith('unsaved edit');
  });
});
