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
| `/p/$projectId` | `routes/p.$projectId.index.tsx` | The studio: outline pane (left), editor pane (center), the margin workspace (right; switchable to the legacy Copilot/Review drawer). Dialogs for sources, export, settings, and starting a run are mounted here, each gated by `useUiStore`'s `activeModal`. |
| `/p/$projectId/runs/$runId` | `routes/p.$projectId.runs.$runId.tsx` → `features/runs` | Run detail: live status, event log, artifacts, cost summary. Header actions include Cancel (while active), Regenerate again (for a `regenerate_section` run), and Resume (issue #124 — only when `run.retryable`; the only place this action appears). |

**Account dialog (per-user LLM key).** The header's account menu has an
“Account settings” item opening `features/account/components/account-dialog.tsx`:
a status line (“No key set” / “Key set, ends in ••••1234, updated <date>”), a
password-type input to set or replace the key, Save and Remove. When
`GET /auth/me` reports `llmKeyConfigurable: false` the dialog explains why and
disables the input. The start-run dialog reads the same `auth.me()` data: under
policy `required` with no key it shows an alert (with a shortcut to the account
dialog) and disables the Start buttons; under `optional` it shows a soft hint
that the shared key will be used. The key is only ever held in the input until
submitted - the API never returns it.

**Content locks (issue #113).** In the studio's outline pane a drafted leaf
section can be *content-locked* from its row's hover action or context menu
(“Lock content — keep as-is on the next run”), from the editor header's lock
button (“Lock content: keep as-is on full runs”), or unlocked from the Copilot
panel's inline hint. A
locked row shows a persistent lock badge, the pane's status bar counts
`N locked`, and an “Unlock all” toolbar action (with a confirm) appears once
anything is locked. The start-run dialog shows “N of M sections are locked.
They will be kept as-is and used as context for the rest.” with an “Unlock all
and regenerate everything” shortcut; the Copilot panel disables regeneration
for a locked node and offers to unlock it; the editor's header lock button shows
as pressed but the section stays editable — what you edit is what the next run keeps
and hands to later sections as context. The rule for *when* a node may be
locked (leaf only, non-blank content) lives in
`src/features/outline/content-lock.ts`, mirroring the API's 409/422 checks;
the API contract is in `docs/WEB_API_REFERENCE.md` (`contentLocked`,
`POST .../outline/unlock-all`). This is distinct from `structureLocked`, which
only controls whether the CLI may split a node.

**Editor header, Chapter options and status bar (issue #182, phase 1).** Once a
section is selected, `features/editor/components/manuscript-sheet.tsx` renders
a header (left to right): the content-lock icon button
(`lock-content-button.tsx`, same enablement rules as the outline row; a button
that cannot act is `aria-disabled`, not `disabled`, so its tooltip stays
reachable), a **Write / Source** toggle group (Source is the CodeMirror
`SectionEditor`; Write is the rendered, read-only manuscript view — the
persisted `editor-store` view is `'write' | 'source'`, a stored legacy
`'preview'` migrates to `'write'`), a **Chapter options** chip opening a popover
(`chapter-options-popover.tsx`) with the section's standing generation brief —
target pages, equation density, math level, summary, sub-prompt — plus the
source scope (`NodeSourcesSection`), saved as you edit (sliders/text debounced,
a pending edit is flushed when the popover closes or the section changes), a
**Copilot** icon button that stays disabled until `ManuscriptSheet` is given an
`onOpenCopilot` callback (the prompt window lands in a later phase), and, pinned
at the far right, a **More** menu (Copy Markdown, Download section .md, Open in
run) followed by the save status. Below the `xl` breakpoint the Chapter options
and save-status labels collapse to icons. There is no Properties sheet any more:
the outline row's gear button and the context menu's *Properties* item were
removed with it.

The editor's status bar (`editor-status-bar.tsx`) shows `N characters · M words`
of the live draft on the left (characters are Unicode code points), an
**`N sources`** button in the middle and, in the Source view, the caret position
`Ln x, Col y` (column in code points) on the right (hidden in Write, which has
no caret in the Markdown source; since phase 2 the Write view publishes the
Markdown position of its text selection too, so the readout appears there once
something is selected). The caret and selection live in
`stores/editor-selection-store.ts` as `{from, to, line, column}` with `from`/`to`
as code-point offsets over the Markdown source, so a caret move re-renders only
the status bar readout. The sources button toggles a non-modal drawer that sits
between the editor and the bar (`sources-drawer.tsx`) listing the section's
effective sources — the resolved scope (own selection, inherited from an
ancestor, or all project sources), each source's chunk count and how many
passages of it the last run cited (`ragCitations` matched on file name; not a live
count), with sources whose indexing failed marked as not searched — and a
*Change scope* link that closes the drawer and opens Chapter options focused on
its Sources section. Escape pressed inside the drawer, or on the sources button,
closes it. What left the status bar compared to before: the `≈ N pages` estimate
and the `N equations` count (dropped), the reviewer score badge (now only in the
right pane's Review tab) and the `Locked` badge (now the pressed state of the
header's lock button). The save status moved to the header.

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
(succeeded/failed/cancelled). A failed run's toast shows the API's
user-facing `error` (for an LLM endpoint failure, "Generation with model X
failed: <reason>. <hint>.") with "Check the run details for the full
error." as its description and a longer display time; the run detail page
(`routes/p.$projectId.runs.$runId.tsx`) shows the same message with the
CLI's original exception text (`errorDetail`, when the API rewrote the
message) collapsed underneath as "Original error".

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


**Margin workspace: anchors, comments and highlights (issue #182, phase 2).**
Human comments live in the margin, a 376px `bg-muted` column that replaces the
old right pane's role. The right column (`features/editor/margin/right-pane.tsx`)
has a **Margin | Copilot** switch (persisted `ui-store.rightPane`, margin by
default): the Copilot side is the legacy `CopilotDrawer` with its Copilot and
Review tabs (its Citations tab moved into the sources drawer, which now has a
*Sources | Citations* toggle; clicking a citation chip opens it on Citations).
Removing the legacy drawer later (phases 3 and 4) is deleting that switch branch
and `CopilotDrawer`. Below 1280px the column is an overlay over the editor's
right edge (`components/layout/use-right-pane.ts`, unpersisted
`ui-store.rightOverlayOpen`), opened by the toolbar button or by starting a
comment, closed with Escape.

*Data.* `api/queries/comments.ts` (`comments.forNode`, create/update/delete/resolve
mutations): writes are optimistic (a new card or message appears at once, the row
badge moves, errors roll back) and always refetch the node's threads and the
outline lists afterwards; MSW mocks (`mocks/handlers.ts`) implement the endpoints,
including a stand-in for the server's re-anchoring on content PATCH. Outline rows
show **open comments** (yellow) and **pending suggestions** (amber) from
`openCommentCount` / `pendingSuggestionCount`
(`features/outline/components/node-count-badges.tsx`, labelled `role="img"`).

*Anchors.* `features/editor/lib/anchors.ts` is pure TypeScript: W3C text-quote
anchors over the Markdown source with **code-point** offsets (`CodePointIndex`
converts to the UTF-16 offsets CodeMirror and the DOM use). `makeAnchor` records
the quote and up to 32 code points of context; `resolveAnchor` tries the stored
offsets (accepted only if the quote is unique), then exact matches decided by the
*whole* stored prefix and suffix (then distance), then a whitespace-normalised
match, then a bounded fuzzy match (Sellers alignment near seed hits or the stored
offset, only for quotes of 12+ characters and 3+ words, span capped at 1.1x the
quote and snapped to word boundaries, head/tail matching beyond 2,000
characters), else it orphans; ambiguous results orphan too (a false positive is
worse). `mapRangeThroughChange` / `diffChange` / `mapAnchorThroughChange` shift
anchors through edits. While a section is open `hooks/use-anchor-positions.ts`
keeps each position right: a new comments list (load, refetch after a save, a
reply from someone else) re-resolves every anchor from its quote against the
current draft; an edit maps the positions through the single changed span, so
deleting the quoted words orphans the card at once. Anchors are never PATCHed
to the server; the server re-anchors on content save.

*Highlights.* Source: `lib/cm-anchor-highlights.ts` is a stable module-level
`StateField` (decorations map through edits; effects replace the set or set the
focused id), clicks on a mark report its anchor ids via `SectionEditor`'s
`onHighlightClick`. Write: `markdown-view.tsx` takes `anchorMarks`/`sourceMap`
and runs two rehype steps (`lib/rehype-anchor-source.ts`) using the
`position.offset`s remark keeps (UTF-16, mapped back through
`normalizeDisplayMathMapped` because `$$..$$` lines are rewritten before parsing):
text nodes are split at range edges and wrapped in `<mark data-anchor-ids>` (a
range crossing elements, inline math and citations is wrapped per text node);
text whose value differs from its source (escapes, entities, quote prefixes) is
aligned character by character (`lib/source-map.ts`); math and citation chips
(opaque rendered output) are highlighted as a whole; text it cannot align is
highlighted as a whole node. Highlight colour is by kind (comment yellow,
suggestion primary, review destructive, resolved muted) plus a distinct
underline style; the focused highlight (its card is focused) gets a stronger fill.

*Selection in Write.* Every positioned text piece carries `data-src-start/end`
(author offsets). `lib/dom-source-selection.ts` maps a DOM `Range` back to a
Markdown range: text boundaries via per-character alignment, boundaries in math,
chips or other opaque output snap to the enclosing source node, element boundaries
move to the nearest tagged text, and whitespace at the edges is trimmed.
`hooks/use-write-selection.ts` publishes the result (and `Ln, Col`) to the
selection store. Known limits: text it cannot align falls back to whole-node
granularity; a selection that only covers rendered-only content (e.g. inside a
KaTeX formula) snaps to the whole formula.

*Selection toolbar.* A floating bar over any non-empty selection, in both views
(`margin/selection-toolbar.tsx`): **Comment** (also `Ctrl+Alt+M` with the text
focused; Escape dismisses the bar). Pointer presses on it are cancelled so the
selection and focus stay in the text. `Prompt…` and the chips (`Add proof`,
`More rigorous`, `Shorter`, `Cite`) and the card's `Send to Copilot` exist but
render only when `margin/flags.ts`'s `COPILOT_ACTIONS_ENABLED` is true (phase 4).

*The margin.* `margin/margin-panel.tsx`: header filter *All · Comments ·
Suggestions · Review*, *Show resolved (n)* (resolved threads are hidden by
default) and *Comment on the whole section*. Cards sit at the y of their
anchor's first line (`margin/geometry.ts` measures: DOM marks in Write,
`coordsAtPos` in Source), stacked top-down by the pure `margin-layout.ts`
(`layoutMargin`; the focused card keeps its y and the cards above it are pushed
up). Section-level and orphaned cards are pinned at the top (orphaned ones show
their struck-through quote). Measuring is batched per animation frame and never
runs per keystroke beyond one read pass; card heights come from one
`ResizeObserver`; the lane scrolls natively and mirrors the text pane's scroll
position both ways. Clicking a highlight focuses its card and focusing a card
(Tab or click) reveals and focuses its highlight. `margin-card.tsx` is the shared
frame (focusable named region, kind icon, status, quote); the per-kind body comes
from `margin/card-registry.tsx` (`MARGIN_CARD_KINDS`): `comment` renders the
thread (messages with author, relative time and an *edited* marker, Markdown body
rendered without HTML, Reply, Resolve/Reopen, Edit/Delete on one's own messages,
a confirm before deleting a thread that has replies); `suggestion` and `review`
render read-only (text and status) until phases 4 and 3 replace their `Body`.
