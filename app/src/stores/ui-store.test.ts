import { afterEach, describe, expect, it } from 'vitest';

import { useUiStore } from './ui-store';

function resetStore() {
  useUiStore.setState({ outlineOpen: true, copilotOpen: true, activeModal: null });
  window.localStorage.clear();
}

describe('useUiStore', () => {
  afterEach(resetStore);

  it('toggles pane visibility', () => {
    useUiStore.getState().toggleOutline();
    expect(useUiStore.getState().outlineOpen).toBe(false);

    useUiStore.getState().toggleCopilot();
    expect(useUiStore.getState().copilotOpen).toBe(false);
  });

  it('opens and closes exactly one modal at a time', () => {
    useUiStore.getState().openModal('sources');
    expect(useUiStore.getState().activeModal).toBe('sources');

    useUiStore.getState().openModal('export');
    expect(useUiStore.getState().activeModal).toBe('export');

    useUiStore.getState().closeModal();
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('persists pane visibility (not the active modal) to localStorage', () => {
    useUiStore.getState().toggleOutline();
    useUiStore.getState().openModal('settings');

    const persisted = JSON.parse(window.localStorage.getItem('autogenbook-ui') ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).toEqual({ outlineOpen: false, copilotOpen: true });
  });
});
