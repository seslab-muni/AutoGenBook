import { describe, expect, it } from 'vitest';

import type { OutlineNode } from '@/api/types';

import {
  CONTENT_LOCK_LEAF_ONLY_MESSAGE,
  CONTENT_LOCK_NEEDS_CONTENT_MESSAGE,
  contentLockDisabledReason,
  contentLockToggleLabel,
  lockedNodes,
} from './content-lock';

function node(overrides: Partial<OutlineNode> & { id: string }): OutlineNode {
  return {
    parentId: null,
    orderIndex: 0,
    cliKey: null,
    title: 'Section',
    summary: '',
    level: 1,
    sectionNumber: '1',
    status: 'not_started',
    targetPages: 1,
    wordBudget: 350,
    actualWords: 0,
    equationDensityLevel: 3,
    mathLevel: 'rigorous',
    subPrompt: null,
    contentMarkdown: '',
    contentLatex: '',
    ragCitations: [],
    reviewerScore: null,
    reviewerNotes: null,
    structureLocked: true,
    contentLocked: false,
    sourceScope: 'inherit',
    sourceIds: [],
    createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z',
    ...overrides,
  };
}

describe('contentLockDisabledReason (issue #113)', () => {
  const parent = node({ id: 'p', contentMarkdown: 'Has text but also children.' });
  const child = node({ id: 'c', parentId: 'p', contentMarkdown: 'Drafted.' });
  const blank = node({ id: 'b', contentMarkdown: '   \n' });
  const locked = node({ id: 'l', contentMarkdown: 'Kept.', contentLocked: true });
  const flat = [parent, child, blank, locked];

  it('allows locking a drafted leaf', () => {
    expect(contentLockDisabledReason(child, flat)).toBeUndefined();
  });

  it('refuses a node with children, even one that has text of its own', () => {
    expect(contentLockDisabledReason(parent, flat)).toBe(CONTENT_LOCK_LEAF_ONLY_MESSAGE);
  });

  it('refuses a blank leaf', () => {
    expect(contentLockDisabledReason(blank, flat)).toBe(CONTENT_LOCK_NEEDS_CONTENT_MESSAGE);
  });

  it('always allows unlocking', () => {
    expect(contentLockDisabledReason(locked, flat)).toBeUndefined();
    expect(contentLockDisabledReason({ ...locked, contentMarkdown: '' }, flat)).toBeUndefined();
  });

  it('labels the toggle by the current state and lists locked nodes', () => {
    expect(contentLockToggleLabel(child)).toMatch(/^Lock content/);
    expect(contentLockToggleLabel(locked)).toBe('Unlock content');
    expect(lockedNodes(flat)).toEqual([locked]);
  });
});
