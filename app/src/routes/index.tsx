import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">TODO: projects list (see issue #16)</p>
    </div>
  );
}
