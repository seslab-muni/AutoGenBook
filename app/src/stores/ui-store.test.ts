import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  useUiStore,
} from './ui-store';

function resetStore() {
  useUiStore.setState({
    outlineOpen: true,
    marginOpen: true,
    rightOverlayOpen: false,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
    activeModal: null,
  });
  window.localStorage.clear();
}

describe('useUiStore', () => {
  afterEach(resetStore);

  it('toggles pane visibility', () => {
    useUiStore.getState().toggleOutline();
    expect(useUiStore.getState().outlineOpen).toBe(false);

    useUiStore.getState().toggleMargin();
    expect(useUiStore.getState().marginOpen).toBe(false);
  });

  it('has no right-pane switch any more, and the narrow overlay has its own unpersisted state', () => {
    expect(useUiStore.getState()).not.toHaveProperty('rightPane');
    useUiStore.getState().setRightOverlayOpen(true);
    expect(useUiStore.getState().rightOverlayOpen).toBe(true);
    const persisted = JSON.parse(window.localStorage.getItem('autogenbook-ui') ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).not.toHaveProperty('rightOverlayOpen');
    // Opening the overlay never touches the wide-screen preference.
    expect(useUiStore.getState().marginOpen).toBe(true);
  });

  it('opens and closes exactly one modal at a time', () => {
    useUiStore.getState().openModal('sources');
    expect(useUiStore.getState().activeModal).toBe('sources');

    useUiStore.getState().openModal('export');
    expect(useUiStore.getState().activeModal).toBe('export');

    useUiStore.getState().closeModal();
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('persists pane visibility and width (not the active modal) to localStorage', () => {
    useUiStore.getState().toggleOutline();
    useUiStore.getState().openModal('settings');

    const persisted = JSON.parse(window.localStorage.getItem('autogenbook-ui') ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).toEqual({
      outlineOpen: false,
      marginOpen: true,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
    });
  });

  it('migrates what an older version stored: copilotOpen becomes marginOpen, rightPane is dropped', async () => {
    window.localStorage.setItem(
      'autogenbook-ui',
      JSON.stringify({
        state: { outlineOpen: false, copilotOpen: false, rightPane: 'copilot', outlineWidth: 400 },
        version: 0,
      }),
    );
    await useUiStore.persist.rehydrate();
    const state = useUiStore.getState();
    expect(state.outlineOpen).toBe(false);
    expect(state.marginOpen).toBe(false);
    expect(state.outlineWidth).toBe(400);
    expect(state).not.toHaveProperty('rightPane');
    expect(state).not.toHaveProperty('copilotOpen');
  });

  it('migrates a stored value of the real v0 shape (what the app wrote before the right-pane tabs went), and survives a garbled one', async () => {
    // Exactly what zustand's persist wrote: `{ state, version }`, with no `version` key at all in the oldest entries.
    window.localStorage.setItem(
      'autogenbook-ui',
      JSON.stringify({
        state: { outlineOpen: true, copilotOpen: true, rightPane: 'margin', outlineWidth: 320 },
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState()).toMatchObject({
      outlineOpen: true,
      marginOpen: true,
      outlineWidth: 320,
    });

    window.localStorage.setItem('autogenbook-ui', JSON.stringify({ state: null, version: 0 }));
    await useUiStore.persist.rehydrate();
    expect(typeof useUiStore.getState().marginOpen).toBe('boolean');

    // A v1 entry is left as it is.
    window.localStorage.setItem(
      'autogenbook-ui',
      JSON.stringify({
        state: { outlineOpen: false, marginOpen: false, outlineWidth: 300 },
        version: 1,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState()).toMatchObject({
      outlineOpen: false,
      marginOpen: false,
      outlineWidth: 300,
    });
  });

  it('clamps setOutlineWidth to [MIN_OUTLINE_WIDTH, MAX_OUTLINE_WIDTH]', () => {
    useUiStore.getState().setOutlineWidth(MIN_OUTLINE_WIDTH - 100);
    expect(useUiStore.getState().outlineWidth).toBe(MIN_OUTLINE_WIDTH);

    useUiStore.getState().setOutlineWidth(MAX_OUTLINE_WIDTH + 100);
    expect(useUiStore.getState().outlineWidth).toBe(MAX_OUTLINE_WIDTH);

    useUiStore.getState().setOutlineWidth(400);
    expect(useUiStore.getState().outlineWidth).toBe(400);
  });
});
