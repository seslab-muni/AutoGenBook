import { Link } from '@tanstack/react-router';

import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';

interface ErrorViewProps {
  error: unknown;
}

/** Route `errorComponent`: renders an `ApiError`'s problem `title`/`detail`, or a generic message. */
export function ErrorView({ error }: ErrorViewProps) {
  const problem = error instanceof ApiError ? error.problem : undefined;
  const title = problem?.title ?? 'Something went wrong';
  const detail = problem?.detail ?? (error instanceof Error ? error.message : undefined);

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      {detail ? <p className="max-w-md text-sm text-muted-foreground">{detail}</p> : null}
      <Button asChild variant="outline">
        <Link to="/">Back to projects</Link>
      </Button>
    </div>
  );
}
