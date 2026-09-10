import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronDown,
  Database,
  Download,
  History,
  LogOut,
  Loader2,
  Play,
  Plus,
  Settings,
  UserRound,
} from 'lucide-react';

import { auth } from '@/api/queries/auth';
import { projects } from '@/api/queries/projects';
import type { Project, Run } from '@/api/types';
import { signOut } from '@/auth/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { useUiStore } from '@/stores/ui-store';

interface AppHeaderProps {
  project: Project;
  /** The project's currently running run, if any (from `useProjectRuns`); unset shows a plain "Run" action even if runs are queued behind it. */
  runningRun?: Run;
  /** How many runs are queued behind `runningRun` — folded into the running button's label. */
  queuedCount: number;
}

/** `h-16` top bar: home/logo, project title + switcher, and the project-level actions. */
export function AppHeader({ project, runningRun, queuedCount }: AppHeaderProps) {
  const navigate = useNavigate();
  const openModal = useUiStore((state) => state.openModal);
  const { data: projectList } = useQuery(projects.list({ limit: 50 }));
  // `requireAuth`'s `beforeLoad` has already populated this cache, so this reads it without
  // another round trip rather than re-deriving it from route context.
  const { data: currentUser } = useQuery(auth.me());

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-background px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <Link
          to="/"
          title="Back to projects"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
        >
          Ω
        </Link>

        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h1 className="truncate text-sm font-bold tracking-tight text-foreground">
              {project.title}
            </h1>
            {projectList && projectList.items.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="Switch project">
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Switch project</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {projectList.items.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      disabled={item.id === project.id}
                      onSelect={() =>
                        void navigate({ to: '/p/$projectId', params: { projectId: item.id } })
                      }
                    >
                      {item.title}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          <p className="truncate text-xs font-medium text-muted-foreground">
            {project.authors[0] ?? project.topic}
            {/* Plain `text-muted-foreground`, not the `/70`-dimmed variant this used to be:
                  the extra opacity dropped this span's contrast below WCAG AA at its `text-xs`
                  size (axe's `color-contrast`, issue #23). */}
            <span className="font-normal text-muted-foreground">
              {' '}
              · Created by {project.ownerName ?? '—'}
            </span>
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => openModal('sources')}>
          <Database />
          Sources
          <Badge variant="secondary">{project.sources?.length ?? 0}</Badge>
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Run history"
          onClick={() => openModal('run-history')}
        >
          <History />
        </Button>

        {runningRun ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary">
                <Loader2 className="animate-spin" />
                Generating…{queuedCount > 0 ? ` · ${queuedCount} queued` : ''}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Running</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openModal('start-run')}>
                <Plus />
                Queue another run
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openModal('run-history')}>
                <History />
                View queue
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button size="sm" onClick={() => openModal('start-run')}>
            <Play />
            Run
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={() => openModal('export')}>
          <Download />
          <span className="hidden md:inline">Export</span>
        </Button>

        <Button variant="outline" size="sm" onClick={() => openModal('settings')}>
          <Settings />
          <span className="hidden lg:inline">Settings</span>
        </Button>

        <Button variant="secondary" size="sm" onClick={() => openModal('new-project')}>
          <Plus />
          <span className="hidden md:inline">New Project</span>
        </Button>

        <ThemeToggle />

        {currentUser ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Account menu">
                <UserRound />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="flex flex-col">
                <span className="font-semibold text-foreground">{currentUser.displayName}</span>
                <span className="font-normal text-muted-foreground">{currentUser.email}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => signOut()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  );
}
