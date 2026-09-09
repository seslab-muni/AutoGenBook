import { useCallback } from 'react';

interface UsePaneResizeOptions {
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  onWidthChange: (width: number) => void;
  /** Widening the pane drags the handle to the right (outline pane); `'left'` for the reverse (e.g. a right-hand pane). */
  direction?: 'right' | 'left';
}

/**
 * Pointer-event drag-to-resize for a side pane, with no extra dependency (see
 * `studio-layout.tsx` for why `react-resizable-panels` doesn't fit here).
 * Returns spread-able handlers for the drag handle element.
 */
export function usePaneResize({
  width,
  min,
  max,
  defaultWidth,
  onWidthChange,
  direction = 'right',
}: UsePaneResizeOptions) {
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max]);

  // `handlePointerMove`/`handlePointerUp` are declared fresh (not memoized) inside
  // `onPointerDown` and close over that gesture's own `startX`/`startWidth` — this avoids the
  // ref juggling a `useCallback` pair with a self-removing `pointerup` handler would need.
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startWidth = width;

      function handlePointerMove(moveEvent: PointerEvent) {
        const delta = moveEvent.clientX - startX;
        const signedDelta = direction === 'right' ? delta : -delta;
        onWidthChange(clamp(startWidth + signedDelta));
      }
      function handlePointerUp() {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      }

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [clamp, direction, onWidthChange, width],
  );

  const onDoubleClick = useCallback(() => onWidthChange(defaultWidth), [defaultWidth, onWidthChange]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = 16;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onWidthChange(clamp(width + (direction === 'right' ? -step : step)));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onWidthChange(clamp(width + (direction === 'right' ? step : -step)));
      } else if (event.key === 'Home') {
        event.preventDefault();
        onWidthChange(min);
      } else if (event.key === 'End') {
        event.preventDefault();
        onWidthChange(max);
      }
    },
    [clamp, direction, max, min, onWidthChange, width],
  );

  return {
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      tabIndex: 0,
      onPointerDown,
      onDoubleClick,
      onKeyDown,
    },
  };
}
