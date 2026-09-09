import { afterEach, describe, expect, it } from 'vitest';

import { useOutlineStore } from './outline-store';

function resetStore() {
  useOutlineStore.setState({ collapsedByProject: {}, seededByProject: {} });
  window.localStorage.clear();
}

describe('useOutlineStore', () => {
  afterEach(resetStore);

  it('toggleCollapsed adds/removes a single node id', () => {
    useOutlineStore.getState().toggleCollapsed('p1', 'n1');
    expect(useOutlineStore.getState().isCollapsed('p1', 'n1')).toBe(true);

    useOutlineStore.getState().toggleCollapsed('p1', 'n1');
    expect(useOutlineStore.getState().isCollapsed('p1', 'n1')).toBe(false);
  });

  it('expand removes ids from the collapsed set without touching others', () => {
    useOutlineStore.getState().toggleCollapsed('p1', 'n1');
    useOutlineStore.getState().toggleCollapsed('p1', 'n2');

    useOutlineStore.getState().expand('p1', ['n1']);

    expect(useOutlineStore.getState().isCollapsed('p1', 'n1')).toBe(false);
    expect(useOutlineStore.getState().isCollapsed('p1', 'n2')).toBe(true);
  });

  describe('seedCollapsed', () => {
    it('collapses the given ids except keepExpandedIds, and marks the project seeded', () => {
      useOutlineStore.getState().seedCollapsed('p1', ['n1', 'n2', 'n3'], ['n2']);

      expect(useOutlineStore.getState().isCollapsed('p1', 'n1')).toBe(true);
      expect(useOutlineStore.getState().isCollapsed('p1', 'n2')).toBe(false);
      expect(useOutlineStore.getState().isCollapsed('p1', 'n3')).toBe(true);
      expect(useOutlineStore.getState().seededByProject.p1).toBe(true);
    });

    it('is a no-op once a project is already seeded', () => {
      useOutlineStore.getState().seedCollapsed('p1', ['n1'], []);
      useOutlineStore.getState().expand('p1', ['n1']);

      useOutlineStore.getState().seedCollapsed('p1', ['n1', 'n2'], []);

      expect(useOutlineStore.getState().isCollapsed('p1', 'n1')).toBe(false);
      expect(useOutlineStore.getState().isCollapsed('p1', 'n2')).toBe(false);
    });
  });

  it('expandAll clears the collapsed set for a project', () => {
    useOutlineStore.getState().collapseAll('p1', ['n1', 'n2']);
    expect(useOutlineStore.getState().isCollapsed('p1', 'n1')).toBe(true);

    useOutlineStore.getState().expandAll('p1');

    expect(useOutlineStore.getState().isCollapsed('p1', 'n1')).toBe(false);
    expect(useOutlineStore.getState().isCollapsed('p1', 'n2')).toBe(false);
  });

  it('collapseAll replaces the collapsed set for a project', () => {
    useOutlineStore.getState().toggleCollapsed('p1', 'stale');

    useOutlineStore.getState().collapseAll('p1', ['n1', 'n2']);

    expect(useOutlineStore.getState().collapsedByProject.p1).toEqual(['n1', 'n2']);
  });

  it('keeps state scoped per project id', () => {
    useOutlineStore.getState().collapseAll('p1', ['n1']);
    useOutlineStore.getState().collapseAll('p2', ['n2']);

    expect(useOutlineStore.getState().isCollapsed('p1', 'n2')).toBe(false);
    expect(useOutlineStore.getState().isCollapsed('p2', 'n1')).toBe(false);
  });
});
