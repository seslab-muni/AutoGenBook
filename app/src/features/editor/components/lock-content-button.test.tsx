import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { http } from 'msw';

import { problemResponse } from '@/mocks/problem';
import { beforeEach, describe, expect, it } from 'vitest';

import { outline } from '@/api/queries/outline';
import type { OutlineNodeUpdate } from '@/api/types';
import {
  CONTENT_LOCK_NEEDS_CONTENT_MESSAGE,
  CONTENT_LOCK_LEAF_ONLY_MESSAGE,
} from '@/features/outline/content-lock';
import { server } from '@/mocks/server';
import { renderWithProviders } from '@/test/component-test-utils';

import { LockContentButton } from './lock-content-button';

const PROJECT_ID = 'book-consensus-quantum-2026';

let patchBodies: OutlineNodeUpdate[];

beforeEach(() => {
  patchBodies = [];
  server.use(
    http.patch('*/api/v1/projects/:projectId/outline/:nodeId', async ({ request }) => {
      patchBodies.push((await request.clone().json()) as OutlineNodeUpdate);
      return undefined;
    }),
  );
});

/** Mirrors `ManuscriptSheet`: the button's node is looked up from the live `outline.flat` cache. */
function Harness({ nodeId }: { nodeId: string }) {
  const { data } = useQuery(outline.flat(PROJECT_ID));
  const flat = data?.items ?? [];
  const node = flat.find((item) => item.id === nodeId);
  if (!node) return null;
  return <LockContentButton projectId={PROJECT_ID} node={node} flat={flat} />;
}

describe('LockContentButton (issue #113)', () => {
  it('is enabled on a drafted leaf and PATCHes contentLocked when toggled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness nodeId="sec-1-1" />);

    const button = await screen.findByRole('button', { name: 'Lock content' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-pressed', 'false');

    await user.click(button);
    await waitFor(() => expect(patchBodies).toContainEqual({ contentLocked: true }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Lock content' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('explains the tooltip on hover', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness nodeId="sec-1-1" />);
    await user.hover(await screen.findByRole('button', { name: 'Lock content' }));
    expect(
      (await screen.findAllByText('Lock content: keep as-is on full runs')).length,
    ).toBeGreaterThan(0);
  });

  it('is disabled on a blank leaf and on a node with children', async () => {
    const { unmount } = renderWithProviders(<Harness nodeId="sec-3-1" />);
    expect(await screen.findByRole('button', { name: 'Lock content' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    unmount();

    renderWithProviders(<Harness nodeId="ch-1" />);
    expect(await screen.findByRole('button', { name: 'Lock content' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('explains why it is disabled in its tooltip, and ignores clicks', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<Harness nodeId="sec-3-1" />);
    const blank = await screen.findByRole('button', { name: 'Lock content' });
    await user.hover(blank);
    expect((await screen.findAllByText(CONTENT_LOCK_NEEDS_CONTENT_MESSAGE)).length).toBeGreaterThan(
      0,
    );
    await user.click(blank);
    expect(patchBodies).toEqual([]);
    unmount();

    renderWithProviders(<Harness nodeId="ch-1" />);
    const container = await screen.findByRole('button', { name: 'Lock content' });
    await user.hover(container);
    expect((await screen.findAllByText(CONTENT_LOCK_LEAF_ONLY_MESSAGE)).length).toBeGreaterThan(0);
  });

  it('keeps the lock off when the server rejects the change', async () => {
    const user = userEvent.setup();
    server.use(
      http.patch('*/api/v1/projects/:projectId/outline/:nodeId', ({ request }) =>
        problemResponse(409, 'Cannot lock this section', new URL(request.url).pathname),
      ),
    );
    renderWithProviders(<Harness nodeId="sec-1-1" />);
    await user.click(await screen.findByRole('button', { name: 'Lock content' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Lock content' })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
  });
});
