import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { outline } from '@/api/queries/outline';
import type { OutlineNodeUpdate } from '@/api/types';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { renderWithProviders } from '@/test/component-test-utils';

import { NodePropertiesSheet } from './node-properties-sheet';

const PROJECT_ID = 'book-consensus-quantum-2026';
const LAMPORT = 'file-lamport-1982-source';
const LAMPORT_NAME = 'Lamport_1982_ByzantineGenerals.pdf';
const CASTRO = 'file-castro-liskov-pbft-source';
const CASTRO_NAME = 'Castro_Liskov_PBFT_TOCS.pdf';

/** Every PATCH body the sheet sends — observed, then passed through to the regular mock handler. */
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

function setScope(nodeId: string, sourceIds: string[]) {
  const node = db.outlineNodes.get(nodeId)!;
  db.outlineNodes.set(nodeId, { ...node, sourceScope: 'selected', sourceIds });
}

/** Mirrors `OutlinePane`: the sheet's node is looked up from the live `outline.flat` cache. */
function Harness({ nodeId }: { nodeId: string }) {
  const { data } = useQuery(outline.flat(PROJECT_ID));
  const flat = data?.items ?? [];
  const node = flat.find((item) => item.id === nodeId) ?? null;
  return (
    <NodePropertiesSheet projectId={PROJECT_ID} node={node} flat={flat} onOpenChange={() => {}} />
  );
}

async function findScopeGroup() {
  return screen.findByRole('radiogroup', { name: 'Source scope' });
}

describe('NodePropertiesSheet sources section (issue #138)', () => {
  it('offers two choices on a chapter and an inherit choice on a nested section', async () => {
    setScope('ch-2', [LAMPORT]);
    const { unmount } = renderWithProviders(<Harness nodeId="ch-1" />);
    const chapterGroup = await findScopeGroup();
    expect(
      within(chapterGroup)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['All project sources', 'Only selected']);
    expect(within(chapterGroup).getByRole('radio', { name: 'All project sources' })).toBeChecked();
    unmount();

    renderWithProviders(<Harness nodeId="sec-2-1" />);
    const sectionGroup = await findScopeGroup();
    expect(within(sectionGroup).getByRole('radio', { name: 'Inherit from §2' })).toBeChecked();
    expect(screen.getByText('Uses the 1 source selected on §2.')).toBeInTheDocument();
  });

  it('"Only selected" opens the picker instead of PATCHing, and Apply sends the selection', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness nodeId="ch-2" />);
    const group = await findScopeGroup();

    await user.click(within(group).getByRole('radio', { name: 'Only selected' }));
    const picker = await screen.findByRole('dialog', { name: 'Choose sources' });
    expect(patchBodies).toEqual([]);

    await user.click(within(picker).getByRole('checkbox', { name: LAMPORT_NAME }));
    await user.click(within(picker).getByRole('checkbox', { name: CASTRO_NAME }));
    await user.click(within(picker).getByRole('button', { name: 'Apply to §2' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Choose sources' })).not.toBeInTheDocument(),
    );
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]?.sourceScope).toBe('selected');
    expect([...(patchBodies[0]?.sourceIds ?? [])].sort()).toEqual([CASTRO, LAMPORT].sort());

    expect(
      await screen.findByRole('button', { name: `Remove ${LAMPORT_NAME}` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Only selected' })).toBeChecked();
    expect(screen.getByText(/Applies to §2\.1 and §2\.2\./)).toBeInTheDocument();
    expect(screen.getByText(/of \d+ chunks · \d+%/)).toBeInTheDocument();
  });

  it('notes which sections override a chapter selection', async () => {
    setScope('ch-2', [LAMPORT]);
    setScope('sec-2-2', [CASTRO]);
    renderWithProviders(<Harness nodeId="ch-2" />);
    expect(
      await screen.findByText(/Applies to §2\.1\. §2\.2 has its own selection\./),
    ).toBeInTheDocument();
  });

  it('removing the last source switches the node back to inherit', async () => {
    const user = userEvent.setup();
    setScope('sec-2-1', [LAMPORT]);
    renderWithProviders(<Harness nodeId="sec-2-1" />);

    await user.click(await screen.findByRole('button', { name: `Remove ${LAMPORT_NAME}` }));

    await waitFor(() => expect(patchBodies).toEqual([{ sourceScope: 'inherit' }]));
    expect(
      await screen.findByRole('radio', { name: 'Inherit (all sources)', checked: true }),
    ).toBeInTheDocument();
  });
});
