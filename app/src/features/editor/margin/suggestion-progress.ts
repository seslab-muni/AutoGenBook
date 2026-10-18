import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import { subscribeSuggestionEvents } from '@/api/sse';
import { currentStatus, putSuggestion, settleSuggestion } from '@/api/queries/revisions';
import { useUnticked } from './hunk-selection';
import type { Comment, SuggestionProgress } from '@/api/types';

const MAX_EVENTS = 60;

interface ProgressState {
  /** Progress events of running suggestions, by suggestion id, in `seq` order. */
  events: Record<string, SuggestionProgress[]>;
  append: (suggestionId: string, event: SuggestionProgress) => void;
  clear: (suggestionId: string) => void;
}

/**
 * The live progress lines of running revisions. Kept in a store (not in the card) because the
 * subscriptions belong to the open section, not to whichever cards the margin filter happens to be
 * showing, and a card that remounts (a filter change, the side sheet closing) must not lose them.
 */
export const useSuggestionProgress = create<ProgressState>()((set) => ({
  events: {},
  append: (suggestionId, event) =>
    set((state) => {
      const list = state.events[suggestionId] ?? [];
      if (list.some((existing) => existing.seq === event.seq)) return state;
      const next = [...list, event].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS);
      return { events: { ...state.events, [suggestionId]: next } };
    }),
  clear: (suggestionId) =>
    set((state) => {
      if (!(suggestionId in state.events)) return state;
      const { [suggestionId]: _gone, ...rest } = state.events;
      void _gone;
      return { events: rest };
    }),
}));

/**
 * Follows every `running` suggestion of the open section: one event stream each (falling back to
 * polling the row, see `subscribeSuggestionEvents`), a progress line into the store, and on the
 * terminal event the finished suggestion into the caches. Re-subscribes by suggestion id after a
 * reload: the stream replays the persisted progress events.
 */
export function useSuggestionStreams(
  projectId: string,
  nodeId: string,
  threads: readonly { root: Comment; replies: Comment[] }[],
  onSettled?: (suggestion: Comment) => void,
): void {
  const queryClient = useQueryClient();
  const subscriptions = useRef(new Map<string, () => void>());
  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  const running = threads
    .flatMap((thread) => [thread.root, ...thread.replies])
    .filter((row) => row.kind === 'suggestion' && row.status === 'running')
    .map((row) => row.id);
  const runningKey = running.join('|');
  const allKey = threads
    .flatMap((thread) => [thread.root, ...thread.replies])
    .filter((row) => row.kind === 'suggestion')
    .map((row) => row.id)
    .join('|');

  // Per-suggestion UI state (progress lines, ticked hunks) goes when its card does.
  useEffect(() => {
    const alive = new Set(allKey === '' ? [] : allKey.split('|'));
    useSuggestionProgress.setState((state) => {
      const kept = Object.entries(state.events).filter(([id]) => alive.has(id));
      return kept.length === Object.keys(state.events).length
        ? state
        : { events: Object.fromEntries(kept) };
    });
    useUnticked.setState((state) => {
      const kept = Object.entries(state.unticked).filter(([id]) => alive.has(id));
      return kept.length === Object.keys(state.unticked).length
        ? state
        : { unticked: Object.fromEntries(kept) };
    });
  }, [allKey]);

  useEffect(() => {
    const wanted = new Set(runningKey === '' ? [] : runningKey.split('|'));
    const active = subscriptions.current;
    for (const [id, stop] of active) {
      if (!wanted.has(id)) {
        stop();
        active.delete(id);
      }
    }
    for (const id of wanted) {
      if (active.has(id)) continue;
      const stop = subscribeSuggestionEvents(id, {
        onProgress: (event) => useSuggestionProgress.getState().append(id, event),
        onTerminal: (_name, suggestion) => {
          active.delete(id);
          if (suggestion) {
            // What the cache says now, not "running": a cancel the person made has already settled
            // this suggestion (and its badge), and the stream's own `cancelled` must not count it twice.
            const before = currentStatus(queryClient, projectId, nodeId, id) ?? 'running';
            putSuggestion(queryClient, projectId, nodeId, suggestion);
            settleSuggestion(queryClient, projectId, nodeId, before, suggestion.status);
            settledRef.current?.(suggestion);
          } else {
            settleSuggestion(
              queryClient,
              projectId,
              nodeId,
              currentStatus(queryClient, projectId, nodeId, id) ?? 'running',
              'failed',
            );
          }
          useSuggestionProgress.getState().clear(id);
        },
      });
      active.set(id, stop);
    }
  }, [runningKey, queryClient, projectId, nodeId]);

  useEffect(() => {
    const active = subscriptions.current;
    return () => {
      for (const stop of active.values()) stop();
      active.clear();
    };
  }, []);
}
