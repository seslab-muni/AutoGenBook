import { type FormEvent, useState } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { auth, useLoginMutation } from '@/api/queries/auth';
import { ApiError } from '@/api/client';
import { getSafeRedirectTarget } from '@/auth/safe-redirect';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useDocumentTitle } from '@/lib/use-document-title';

interface LoginSearch {
  redirect?: string;
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  // If a session already exists (e.g. the user navigated back to /login, or opened a stale
  // tab), send them straight on rather than showing the form. `/login` is deliberately the one
  // route with no `requireAuth` guard, so this check is inline here instead.
  beforeLoad: async ({ context, search }) => {
    try {
      await context.queryClient.ensureQueryData(auth.me());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      throw error;
    }
    throw redirect({ href: getSafeRedirectTarget(search.redirect) });
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect: redirectParam } = Route.useSearch();
  const navigate = useNavigate();
  const loginMutation = useLoginMutation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  useDocumentTitle('Sign in');

  const errorMessage =
    loginMutation.isError && loginMutation.error instanceof ApiError
      ? (loginMutation.error.problem?.detail ?? loginMutation.error.problem?.title ?? 'Sign in failed.')
      : loginMutation.isError
        ? 'Sign in failed.'
        : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    loginMutation.mutate(
      { email, password },
      {
        // `useLoginMutation`'s own `onSuccess` has already seeded `auth.me()`'s cache with the
        // returned user by the time this runs (mutation `onSuccess` callbacks passed to
        // `.mutate()` fire after the ones registered on the hook itself).
        onSuccess: () => {
          void navigate({ href: getSafeRedirectTarget(redirectParam) });
        },
      },
    );
  }

  return (
    <div className="flex h-screen items-center justify-center p-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Sign in to your AutoGenBook Studio account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="text-xs font-semibold text-foreground">
                Email
              </label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={loginMutation.isPending}
                required
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-xs font-semibold text-foreground">
                Password
              </label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={loginMutation.isPending}
                required
              />
            </div>

            {errorMessage ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            ) : null}

            <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
