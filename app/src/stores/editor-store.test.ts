import { afterEach, describe, expect, it } from 'vitest';

import { useEditorStore } from './editor-store';

describe('editor store persistence', () => {
  afterEach(() => {
    localStorage.clear();
    useEditorStore.setState({ view: 'write' });
  });

  it('defaults to the Write view', () => {
    expect(useEditorStore.getState().view).toBe('write');
  });

  it("migrates a stored v0 'preview' view to 'write' and keeps 'source'", async () => {
    localStorage.setItem(
      'autogenbook-editor',
      JSON.stringify({ state: { view: 'preview' }, version: 0 }),
    );
    await useEditorStore.persist.rehydrate();
    expect(useEditorStore.getState().view).toBe('write');

    localStorage.setItem(
      'autogenbook-editor',
      JSON.stringify({ state: { view: 'source' }, version: 0 }),
    );
    await useEditorStore.persist.rehydrate();
    expect(useEditorStore.getState().view).toBe('source');
  });
});
