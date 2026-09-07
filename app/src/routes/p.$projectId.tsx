import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/p/$projectId')({
  component: ProjectPage,
});

function ProjectPage() {
  const { projectId } = Route.useParams();

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">
        TODO: project workspace for {projectId} (see issue #16/#17)
      </p>
    </div>
  );
}
