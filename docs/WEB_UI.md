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
no caret of its own; since phase 2 it publishes the Markdown position of the
text selection, so the readout appears there once something is selected). The caret and selection live in
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

**Margin workspace: anchors, comments and highlights (issue #182, phase 2).**
Human comments live in the margin, a 376px `bg-muted` column that replaces the
old right pane's role.

*Right column.* `features/editor/margin/right-pane.tsx` has a **Margin | Copilot**
switch (persisted `ui-store.rightPane`, margin by default); the Copilot side is the
legacy `CopilotDrawer` (Copilot and Review tabs; Citations moved into the sources
drawer, which has a *Sources | Citations* toggle, and a citation chip opens it on
Citations). The open section renders its margin into the column's slot by portal
(`MarginHostContext`), because the sheet owns the comment data and the text
geometry. Below 1280px (`components/layout/use-right-pane.ts`, hook
`useRightColumn`) the column is a managed, non-modal **side sheet** over the editor's
right edge: it opens from the toolbar button or when a comment is started, closes
with its close button, on a press outside it (dialogs and menus it opened are
exempt) and on Escape from anywhere (an open dialog owns that Escape; a composer
stops its own), and while it is open the editor pane gets matching right padding so
the text being commented on stays visible. Its open state is the unpersisted
`ui-store.rightOverlayOpen`, so opening it on a narrow screen never changes the
saved wide-screen preference (`copilotOpen`).

*Removing the legacy drawer (phases 3 and 4) is deleting, not rewriting.* Everything
that goes with it, in one list:
- `features/editor/components/copilot-drawer.tsx` and `copilot-drawer.test.tsx`;
  `features/editor/components/review-panel.tsx` and `review-panel.test.tsx` (phase 3's
  review cards replace the Review tab); `features/runs/components/copilot-panel.tsx` and
  its test (phase 4 replaces it; check `features/runs` for other users first).
- `margin/right-pane.tsx`: the `copilot` branch, the `Margin | Copilot` `ToggleGroup`, the
  `tab` / `onTabChange` / `project` props and the `CopilotTab` import. `RightColumn` then
  reduces to the close button and the margin slot.
- `stores/ui-store.ts`: `rightPane`, `setRightPane`, `RightPane` and `useRightPaneMode`;
  keep `copilotOpen` / `toggleCopilot` / `rightOverlayOpen` (they belong to the column, not
  to the drawer) or rename them when the column is renamed. The `setRightPane('margin')`
  call in `useRightColumn().revealMargin` (`components/layout/use-right-pane.ts`) goes too
  (the action `ui-store.revealMargin` no longer exists).
- `routes/p.$projectId.tsx`: the `tab` search param, `TABS` and `ProjectTab`;
  `routes/p.$projectId.index.tsx`: `tab`, `handleTabChange` and the `tab` prop passed down;
  an old `?tab=` link is then just an unknown search value.
- `components/layout/studio-layout.tsx`: the `copilotPane` prop (rename it, e.g.
  `rightPane`) and its doc comment; the aria-labels "Show right pane" / "Close right pane"
  stay valid.

*Data.* `api/queries/comments.ts` (`comments.forNode`, create/update/delete/resolve
mutations): resolve and delete are optimistic (the card or badge moves at once,
errors roll back and toast the server's message); create and edit take
`{ optimistic: false }` from the cards, because their composers stay open until the
server answers. Every write refetches the node's threads and the outline lists, and a
successful `contentMarkdown` save also refetches the node's comments (the server
re-anchors on save). MSW mocks (`mocks/handlers.ts`) implement the endpoints,
including a stand-in for that re-anchoring. Outline rows show **open comments**
(yellow, round) and **pending suggestions** (amber, square) as count-only pills from
`openCommentCount` / `pendingSuggestionCount`
(`features/outline/components/node-count-badges.tsx`, `role="img"` with the kind in
the accessible name and tooltip).

*Anchors.* `features/editor/lib/anchors.ts` is pure TypeScript: W3C text-quote
anchors over the Markdown source with **code-point** offsets (`CodePointIndex`
converts to the UTF-16 offsets CodeMirror and the DOM use). `makeAnchor` records the
quote and up to 32 code points of context. `resolveAnchor` tries the stored offsets
(accepted only if the quote is unique), then exact matches, then a whitespace-
normalised match, then a bounded fuzzy match, else it orphans (a false positive is
worse). Among exact hits, context decides, never word boundaries: hits where the
stored prefix *and* suffix both agree in full, then hits where one side does (then
distance to the stored start); a context shorter than 32 code points means the quote
was at the text's edge and only agrees with a hit at that edge; a quote under 12
characters or 3 words is never accepted without one side agreeing, even as the only
hit; ambiguity orphans. Fuzzy matching (Sellers alignment near seed hits or the stored
offset; span capped at 1.1x the quote, snapped to word boundaries; head/tail matching
beyond 2,000 characters) is only for quotes of 12+ characters and 3+ words.
`mapRangeThroughChange` / `diffChange` / `mapAnchorThroughChange` shift anchors
through edits.

*Keeping anchors right while a section is open.* In the Source view
`lib/cm-anchor-highlights.ts` is the single source of truth: one module-level
`StateField` tracks every located range through CodeMirror's own change sets (the
start edge is non-inclusive, so text typed right before a highlight stays outside it;
an edit that swallows a range flags it deleted), draws the visible ones as mark
decorations, and reports positions back after each edit (`onHighlightsMapped`).
`hooks/use-anchor-positions.ts` merges that into React state: a new comments list
re-resolves only rows whose `anchor` object changed (react-query keeps identity for
unchanged ones). A row whose `anchor` changed because the server re-anchored it keeps the
editor's position when it has one (typing inside a commented range across an autosave
does not make the highlight or card blink), takes the server's only when it has none or
the text was replaced from outside, and an orphan stays an orphan (never goes back to
"pending") when the server also says it has no place. An anchor with no position is
searched for again (fuzzy included, one at a time, never in render) a
moment after the text last changed, using what the anchor looked like last (quote and
context as edited, remembered while it was located) rather than the server's copy,
which goes stale around the user's edits; so deleting the quoted words orphans the
card (after that short search) and undoing brings it back. Until the search has failed
once a card is *pending*, not orphaned; the search runs at most once per text and anchor,
and quotes over 500 characters are matched by their first and last 200 (an alignment of
a long quote would take far too long). The Write view's text only changes from outside
(server content), which re-resolves every anchor from its quote (`resetKey`); it has no
edits of its own to map. The decoration field is only pushed to when the resolved
set really differs from what it holds (never per keystroke) and never during an IME
composition. Anchors are never PATCHed; the server re-anchors on content save.
Section text is counted over LF: a CR LF section is normalised on load
(`lib/eol.ts`), as CodeMirror does, and the anchors' quote and context are normalised
the same way.

*Server content changing under an open editor.* The draft is no longer seeded once.
When the node's `contentMarkdown` changes on the server (an accepted suggestion,
another editor) and the editor has no unsaved edits, `ManuscriptSheet` adopts it and
re-resolves the anchors; with unsaved edits it keeps the draft, **holds autosave** (the
save status stays unsaved, and the blur or `Ctrl+S` flush does nothing) and shows a notice
that makes overwriting an explicit choice: *Keep mine* saves the draft over the other
version, *Load the other version* replaces the draft without saving. Text applied from
outside is kept out of CodeMirror's undo history (`transactionExtender` on the
`ExternalChange` annotation), so `Ctrl+Z` cannot bring back what the other side replaced
and autosave it, and the highlights are pushed again once the replace has landed. Cards
reach this through `MarginCardContext`: `applyServerContent(markdown)`, `hasUnsavedEdits()`
and `flushEdits()` (resolves when nothing is pending or in flight; rejects on a failed
save or while saving is held), so an Accept can wait for an in-flight save, warn about
unsaved edits and then adopt the rewritten text.

*Freshness.* The open section's threads and the outline's badge counts are fetched again
every 15 s (`COLLABORATION_POLL_MS`; paused while the tab is hidden), so a second user's
comment, reply or badge shows up without any action. A section's own content is not
polled: another editor's change arrives with the next refetch of the node (focus, remount).

*Highlights.* Write view: `markdown-view.tsx` is memoised and its parsed element
depends on the Markdown alone, with module-level component overrides reading chips'
data through context, so highlight, focus, filter and citation changes never re-run
the remark/rehype/KaTeX pipeline or replace the DOM the reader's selection lives in.
Highlights are painted with the **CSS Custom Highlight API** (`lib/write-highlights.ts`:
one highlight per kind plus a prioritised focused one; opaque pieces such as math and
citation chips get a `data-anchor-hit` attribute and an outline instead; a click is
hit-tested against the painted rectangles under the pointer, shortest range first, so a
click beside a line's end or on a nested highlight's neighbour picks the right card and
link/chip clicks go through). The registry is document-wide, so every `MarkdownView` adds
to one union per kind and an instance without highlights never touches it. Where the API is missing the ranges are
wrapped in `<mark>`s by rehype instead (`lib/rehype-anchor-source.ts`), which does
re-run the pipeline when they change. Both use the `position.offset`s remark keeps
(UTF-16, mapped back through `normalizeDisplayMathMapped` because `$$..$$` lines are
rewritten before parsing). Every positioned text piece is wrapped in a
`span[data-src-start/end]`; text whose value differs from its source (escapes,
entities, block-quote line prefixes, collapsed whitespace) is aligned character by
character (`lib/source-map.ts`), `remarkCitations` positions the pieces around a
citation the same way, and fenced/indented/inline code text gets positions too. Math
and citation chips are highlighted as a whole (display math as a block). Colours and
underline styles are CSS variables in `index.css` (comment solid, suggestion dashed,
review dotted, resolved double, unsent draft wavy). Measured in both themes: plain text and
links on every fill keep at least 4.5:1 (Write light 4.66, Write dark 4.64, Source light
7.35); in Source dark every syntax token on a highlight is no worse than the same token
off it (the theme's own low-contrast tokens, such as its comment grey at 3.9:1, are not
touched); every underline is at least 3:1 against the page. In dark the fill keeps the
lightness of its surface (relative colour on `--anchor-surface`, registered with
`@property` so `::highlight()` receives a resolved colour) and only moves hue and chroma,
so the tint is modest there and the underline style carries the distinction. Clicking a highlight
focuses its card and focusing a card (Tab or click) reveals and focuses its highlight.

*Selection.* In the Write view every positioned text piece carries its Markdown
offsets; `lib/dom-source-selection.ts` maps a DOM `Range` back to a source range
(per-character alignment; boundaries in math, chips or other opaque output snap to the
enclosing source node; element boundaries move to the nearest tagged text; edge
whitespace trimmed) and `hooks/use-write-selection.ts` publishes it, with `Ln, Col`,
to the selection store. `margin/selection-layer.tsx` owns everything that follows the
selection (the store subscription, the toolbar, the shortcut), so a selection change
re-renders only it, never the sheet. The toolbar floats over a non-blank selection in
either view and is hidden while the selection is out of view; it offers **Comment**
(`Ctrl+Alt+M` with the text focused; with only a caret inside a highlight the same
shortcut instead moves keyboard focus to that highlight's card; Escape dismisses the
bar) and never takes focus or the selection. `Prompt…`, the chips (`Add proof`, `More
rigorous`, `Shorter`, `Cite`) and the card's `Send to Copilot` render only when
`margin/flags.ts`'s `COPILOT_ACTIONS_ENABLED` is true (phase 4). **Keyboard-only
commenting works from the Source view**: the Write view has no caret, so there a
keyboard user can read comments through the cards but cannot start one.

*The margin.* `margin/margin-panel.tsx`: filter *All · Comments · Suggestions ·
Review*, *Show resolved (n)* (resolved threads hidden by default), *Comment on the
whole section*. Each card sits at the y of its anchor's first line (`geometry.ts`:
painted ranges in Write, `coordsAtPos` in Source), stacked top-down by the pure
`margin-layout.ts` (`layoutMargin`; the focused card keeps its y and the cards above
it are pushed up). Section-level and orphaned cards are pinned at the top of the text
column (they scroll away with the text); an anchor that resolves but has no rendered
highlight in the current view is placed by the nearest positioned block and labelled
*Not shown in this view*. The card lane never scrolls by itself: it is translated by
the text pane's scroll position (set on the element, no re-render), a wheel over it is
forwarded to the text pane, and the text pane is given extra bottom space when cards
are stacked past its last line, so the text can always be scrolled to both ends with
every card level with its text. Anchor and card-height measuring is batched per
animation frame (anchors far from the viewport keep their last measure until scrolled near,
so CodeMirror's height revisions do not re-lay out 150 cards on every wheel step). The extra
scroll space is a spacer *inside* the Write view's scroll content (CodeMirror: bottom padding of
its content) and is recomputed whenever the geometry reports the content height changed; a
focused card the layout pushed out of sight is scrolled into view; a touch drag over the lane
scrolls the text pane. Composers (new comment, reply, edit) stay open with their text until
the server accepts it (the new comment is written into the cache from the POST response before
it closes, so nothing disappears until the refetch), show the server's message on failure and
ignore a second submit; unsent text lives in `useMarginStore.drafts` (keyed `node:new`,
`node:reply:<thread>`, `node:edit:<comment>`), so it survives the composer unmounting (the
narrow side sheet closing, switching to Copilot and back) and is restored on reopen, cleared
on a successful send or an explicit cancel; after a reply or edit is sent or cancelled, a
reply is deleted, or a delete dialog is dismissed, keyboard focus returns to the card or the
control that opened it (to the text when the card itself goes away);
Reply/Resolve/Edit/Delete are disabled on an optimistic row; deleting a thread always
confirms; relative times tick (one shared timer). A LaTeX-only section (no
`contentMarkdown`) gets no range comments (the server anchors against Markdown); only
whole-section comments, with a note in the margin.

*Card registry (`margin/card-registry.tsx`).* `MARGIN_CARD_KINDS: Record<CommentKind,
{ label, icon, Status?, Quote?, Body }>`: `MarginCard` is the shared frame (position,
focus, header, quote area, body) and each slot takes `{ thread, ctx, approximate }`.
`Status` is the header's right-hand side (default: Orphaned / Whole section /
Resolved badges; suggestion cards put running/pending/failed there, review cards the
severity and type pills), `Quote` the quote area (default: the quoted text; suggestion
cards put their diff there), `Body` everything below. `suggestion` and `review` render
read-only until phases 4 and 3 replace their entries. `MarginCardContext` is `{
projectId, nodeId, currentUserId, copilotActions, restoreEditorFocus,
applyServerContent, hasUnsavedEdits, flushEdits, onSendToCopilot? }`. `ComposerDraft` in
`margin-store.ts` is a discriminated union (`{ kind: 'comment'; anchor }` today; every kind
carries `anchor`): the margin positions and highlights any draft from `anchor` alone and
renders it through `COMPOSER_KINDS` (`margin/composer-registry.tsx`), so the prompt window
adds a member to the union and one registry entry. `SelectionLayer` takes `onPrompt` and
`onChip`, and the thread body takes `ctx.onSendToCopilot`: each of the three copilot
buttons renders only with `COPILOT_ACTIONS_ENABLED` on **and** its handler supplied.

*Known limits.* The CSS Custom Highlight API is absent in older browsers (the `<mark>`
fallback re-parses the Markdown when highlights change). Text the aligner cannot map
falls back to whole-node granularity, and a Write selection inside a KaTeX formula
snaps to the whole formula. After a long run of edits around an orphaned anchor its
quote may be gone for good; it is then kept as an orphan, never deleted. A CR LF
section is saved as LF the first time it is edited, and until then a freshly created
multi-line comment can be orphaned server-side (the server counts the CR LF text); it is
re-found by its quote in the editor. `::highlight()` supports colours and text decorations
only, and not every browser paints the underline style there, so on such a browser the kinds
are told apart by the tint alone (the Custom Highlight API itself is feature-detected and
the `<mark>` fallback used where it is missing, but the decoration support inside it is not
detectable cheaply). In the Source view CodeMirror
estimates the height of lines it has not rendered, so a card for an anchor far from the
viewport can sit a few pixels off until the text is scrolled there.

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
