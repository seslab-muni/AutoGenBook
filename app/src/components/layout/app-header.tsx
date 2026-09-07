import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, Database, Download, Loader2, Play, Plus, Settings } from 'lucide-react';
import { toast } from 'sonner';

import { projects } from '@/api/queries/projects';
import type { Project, Run } from '@/api/types';
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
  /** The project's active run, once #21 wires run creation/polling up; unset shows a plain "Run" action. */
  activeRun?: Run;
}

const RUNNING_STATUSES = new Set<Run['status']>(['queued', 'running']);

/** `h-16` top bar: home/logo, project title + switcher, and the project-level actions. */
export function AppHeader({ project, activeRun }: AppHeaderProps) {
  const navigate = useNavigate();
  const openModal = useUiStore((state) => state.openModal);
  const { data: projectList } = useQuery(projects.list({ limit: 50 }));
  const isRunning = activeRun ? RUNNING_STATUSES.has(activeRun.status) : false;

  function handleRun() {
    if (activeRun) return;
    toast.info('Runs are not wired up yet', { description: 'Tracked in issue #21.' });
  }

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
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => openModal('sources')}>
          <Database />
          Sources
          <Badge variant="secondary">{project.sources.length}</Badge>
        </Button>

        <Button size="sm" onClick={handleRun} disabled={isRunning}>
          {isRunning ? <Loader2 className="animate-spin" /> : <Play />}
          {isRunning ? 'Running…' : 'Run'}
        </Button>

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
      </div>
    </header>
  );
}
