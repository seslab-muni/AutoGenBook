import { createFileRoute } from '@tanstack/react-router';

import { useDocumentTitle } from '@/lib/use-document-title';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  useDocumentTitle();

  return (
    <div className="flex h-screen items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">TODO: projects list (see issue #17)</p>
    </div>
  );
}
