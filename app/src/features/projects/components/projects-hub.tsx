import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Plus, Search } from 'lucide-react';

import { projects } from '@/api/queries/projects';
import type { ProjectSummary } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectCard } from '@/features/projects/components/project-card';
import { useUiStore } from '@/stores/ui-store';

const LIST_PARAMS = { limit: 100 };

function matchesSearch(project: ProjectSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    project.title.toLowerCase().includes(needle) ||
    project.subtitle.toLowerCase().includes(needle) ||
    project.topic.toLowerCase().includes(needle) ||
    project.authors.some((author) => author.toLowerCase().includes(needle))
  );
}

export function ProjectsHub() {
  const [search, setSearch] = useState('');
  const openModal = useUiStore((state) => state.openModal);
  const { data, isPending } = useQuery(projects.list(LIST_PARAMS));
  const items = data?.items ?? [];
  const filtered = items.filter((project) => matchesSearch(project, search));

  let hubBody: React.ReactNode;
  if (isPending) {
    hubBody = (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {['a', 'b', 'c'].map((key) => (
          <Skeleton key={key} className="h-36 w-full rounded-xl" />
        ))}
      </div>
    );
  } else if (filtered.length === 0 && items.length === 0) {
    hubBody = (
      <EmptyState
        icon={BookOpen}
        title="No projects yet"
        description="Create your first AutoGenBook project to get started."
        action={
          <Button size="sm" onClick={() => openModal('new-project')}>
            <Plus />
            New project
          </Button>
        }
      />
    );
  } else if (filtered.length === 0) {
    hubBody = (
      <EmptyState
        icon={Search}
        title="No matching projects"
        description={`Nothing matches "${search}".`}
      />
    );
  } else {
    hubBody = (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            Ω
          </span>
          <h1 className="text-sm font-bold tracking-tight text-foreground">AutoGenBook Studio</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => openModal('new-project')}>
            <Plus />
            <span className="hidden sm:inline">New Project</span>
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects by title, topic, or author…"
              className="pl-9"
              aria-label="Search projects"
            />
          </div>
          <p className="shrink-0 text-xs font-medium text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? 'project' : 'projects'}
          </p>
        </div>

        {hubBody}
      </main>
    </div>
  );
}
