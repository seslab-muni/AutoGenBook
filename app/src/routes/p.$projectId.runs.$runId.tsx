import { createFileRoute } from '@tanstack/react-router';

import { EmptyState } from '@/components/empty-state';
import { useDocumentTitle } from '@/lib/use-document-title';

export const Route = createFileRoute('/p/$projectId/runs/$runId')({
  component: RunPage,
});

function RunPage() {
  const { runId } = Route.useParams();
  useDocumentTitle(`Run ${runId}`);

  return (
    <EmptyState
      title="Run detail coming soon"
      description={`The run timeline and artifacts for ${runId} land in issue #21.`}
    />
  );
}
