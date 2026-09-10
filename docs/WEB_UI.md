# Web UI

`app/` is the Vite + React 19 (strict TypeScript) frontend for AutoGenBook,
served by nginx in the Docker Compose stack and talking to `api/` over
`/api/v1`. This doc covers the screens, who owns which piece of state, and
how the SSE/run-streaming path works; see `app/README.md` for setup,
scripts, folder layout, the API client layer, and testing (including the
Playwright e2e/a11y suite).

## Screens

| Route | Component | What it does |
| --- | --- | --- |
| `/login` | `routes/login.tsx` | Email/password sign-in; redirects to `/` (or `?redirect=`) on success. |
| `/` | `routes/index.tsx` → `features/projects` | Projects hub: search/filter, create/duplicate/delete a project. |
| `/p/$projectId` | `routes/p.$projectId.index.tsx` | The studio: outline pane (left), editor pane (center), copilot/citations/review tabs (right). Dialogs for sources, export, settings, and starting a run are mounted here, each gated by `useUiStore`'s `activeModal`. |
| `/p/$projectId/runs/$runId` | `routes/p.$projectId.runs.$runId.tsx` → `features/runs` | Run detail: live status, event log, artifacts, cost summary. Header actions include Cancel (while active), Regenerate again (for a `regenerate_section` run), and Resume (issue #124 — only when `run.retryable`; the only place this action appears). |

`routes/__root.tsx` mounts the app shell once (theme toggle, toaster, the
`NewProjectDialog` — reachable from both the hub and the studio header) and
owns the top-level `notFoundComponent`/`errorComponent` (the latter reports
to `src/lib/report-error.ts`, see `app/README.md`'s "Error reporting"
section).

## State ownership

Three places own state, and nothing is copied between them:

| Owner | Holds | Examples |
| --- | --- | --- |
| TanStack Query (`src/api/queries/*`) | Server state — anything that came from the API. | Projects, sources, outline nodes, runs, files. Cache invalidation is hierarchical (`src/api/queries/keys.ts`), so mutating a project cascades to its sources/outline/runs. |
| Route search params (`routes/p.$projectId.tsx`'s `ProjectSearch`) | Shareable/URL state. | The selected outline node (`?node=`) and the right-pane tab (`?tab=`) — refreshing or sharing the URL preserves them. |
| `src/stores/ui-store.ts` (Zustand) | Client-only UI state that isn't server data or shareable. | Outline/copilot pane visibility and width, which modal (if any) is open. Pane visibility/width persist to `localStorage`; the open modal always resets to closed on reload. |

Theme is a fourth, separate case: `next-themes` (`app/providers.tsx`) owns
it entirely — it applies/removes the `dark` class, resolves `system` against
the OS preference, and persists the choice — specifically so `sonner`'s
`Toaster` (which reads theme via `next-themes`' own `useTheme()`) stays in
sync without the UI store needing to know about it.

Auth is a fifth: the session itself is an httpOnly cookie the browser
manages, invisible to JS. `src/auth/session.ts`'s `Session` type is just the
shape `GET /auth/me` returns, cached like any other query; `requireAuth`
(`src/auth/require-auth.ts`) is a route `beforeLoad` that ensures that query
resolves before rendering a protected route.

## Run streaming

`src/api/sse.ts`'s `subscribeRunEvents` opens an SSE connection to a run's
event stream and falls back to polling (`GET` the events endpoint plus the
run itself every `pollIntervalMs`, default 2000ms) after repeated connection
errors — the run detail route and any other consumer of `useRunStream`
(`features/runs/hooks/use-run-stream.ts`) don't need to know which
transport is currently active. On every `section` event (issue #129), not
only the terminal `done`, it records the section's `nodeKey` (for the
outline's per-node "still generating" spinners) and invalidates the run's
artifacts and the project's outline/detail queries, so newly-uploaded
sections and their content show up live while the run is still in progress
instead of only once it finishes; `done` additionally invalidates
sources/project and shows a `sonner` toast summarizing the outcome
(succeeded/failed/cancelled).

## Known limitations

- **No token-level streaming of generated content** — a section's status
  moves through `queued → drafting → compiled` (or `review-ready`) via run
  events, but the text itself only appears once the CLI has written the
  section file; there's no incremental token stream into the editor.
- **arXiv import, BibTeX import, and URL ingest are UI-only stubs** — the
  Sources dialog shows them as disabled tabs (`UploadDropzone`'s
  `DISABLED_INGEST_TABS`) because the backend has no endpoints for them yet
  (deferred by issue #5).
- **No self-service signup or password reset** — accounts are seeded and
  rotated entirely through `api/scripts/users.py` (issue #96); there's
  deliberately no such flow in the UI.
- **`app/_reference/`, the AI-Studio-exported mock UI this rewrite used as a
  layout/styling reference, is gone** (deleted by issue #23) — if older
  comments or PRs mention it, treat them as historical.
