import { useMemo } from 'react';
import { create } from 'zustand';

// ---------------------------------------------------------------------------------------------
// Which hunks of a section suggestion are ticked (all, until the reader unticks some).
// ---------------------------------------------------------------------------------------------

const NONE: readonly number[] = [];

export const useUnticked = create<{
  unticked: Record<string, readonly number[]>;
  toggle: (id: string, hunk: number) => void;
}>()((set) => ({
  unticked: {},
  toggle: (id, hunk) =>
    set((state) => {
      const current = state.unticked[id] ?? NONE;
      const next = current.includes(hunk) ? current.filter((h) => h !== hunk) : [...current, hunk];
      return { unticked: { ...state.unticked, [id]: next } };
    }),
}));

export function useSelectedHunks(id: string, total: number) {
  const unticked = useUnticked((state) => state.unticked[id]) ?? NONE;
  const toggle = useUnticked((state) => state.toggle);
  const selected = useMemo(
    () => new Set(Array.from({ length: total }, (_, i) => i).filter((i) => !unticked.includes(i))),
    [total, unticked],
  );
  return { selected, toggle: (hunk: number) => toggle(id, hunk) };
}
