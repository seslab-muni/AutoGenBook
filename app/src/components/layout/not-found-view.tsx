import { Link } from '@tanstack/react-router';

import { Button } from '@/components/ui/button';

interface NotFoundViewProps {
  message?: string;
}

export function NotFoundView({
  message = "We couldn't find what you were looking for.",
}: NotFoundViewProps) {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-lg font-semibold text-foreground">Not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button asChild>
        <Link to="/">Back to projects</Link>
      </Button>
    </div>
  );
}
