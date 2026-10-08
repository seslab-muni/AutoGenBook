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
| `/p/$projectId` | `routes/p.$projectId.index.tsx` | The studio: outline pane (left), editor pane (center), the margin workspace (right: comments, review issues and the copilot's suggestions). Dialogs for sources, export, settings, and starting a run are mounted here, each gated by `useUiStore`'s `activeModal`. |
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
(“Lock content — keep as-is on the next run”) or from the editor header's lock
button (“Lock content: keep as-is on full runs”). A
locked row shows a persistent lock badge, the pane's status bar counts
`N locked`, and an “Unlock all” toolbar action (with a confirm) appears once
anything is locked. The start-run dialog shows “N of M sections are locked.
They will be kept as-is and used as context for the rest.” with an “Unlock all
and regenerate everything” shortcut; a *Rewrite* of a locked node is refused by the
API (its 409 reason is shown in the prompt window; unlock from the header button),
while *Revise* works on a locked node, since the lock only protects the text against
runs; the editor's header lock button shows
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
**Copilot** icon button that opens the prompt window at section scope (it is
`aria-disabled`, with its reason in the tooltip, for a container node only; for a
LaTeX-only section it opens the window locked to Rewrite, since the server anchors
and revises Markdown; it is what keyboard focus returns to when the window closes), and, pinned
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
and the `N equations` count (dropped), the reviewer score badge (now in the margin's
review summary strip, when a run produced one) and the `Locked` badge (now the pressed state of the
header's lock button). The save status moved to the header.

**Margin workspace: anchors, comments and highlights (issue #182, phase 2).**
Human comments live in the margin, a 376px `bg-muted` column that replaces the
old right pane's role.

*Right column.* `features/editor/margin/right-pane.tsx` is the close button and the slot
the open section portals its margin into (`MarginHostContext`), because the sheet owns
the comment data and the text geometry. There is no Margin | Copilot switch, no tabs and
no legacy drawer any more (see *The legacy drawer is gone*). Below 1280px
(`components/layout/use-right-pane.ts`, hook `useRightColumn`) the column is a managed,
non-modal **side sheet** over the editor's right edge: it opens from the toolbar button
or when a comment or prompt is started, closes with its close button, on a press outside
it (dialogs and menus it opened are exempt, and so are the copilot's own entry points, the
header Copilot button and the selection bar, which open the sheet themselves: closing it
first moved the editor under the pointer and lost the click) and on Escape from anywhere
(an open dialog owns that Escape; a composer and the prompt window stop their own), and
while it is open the editor pane gets matching right padding so the text being commented
on stays visible. Its open state is the unpersisted `ui-store.rightOverlayOpen`, so
opening it on a narrow screen never changes the saved wide-screen preference
(`marginOpen`).

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
selection (the store subscription, the toolbar, the shortcuts), so a selection change
re-renders only it, never the sheet. The toolbar floats over a non-blank selection in
either view and is hidden while the selection is out of view; it offers **Comment**
(`Ctrl+Alt+M` with the text focused; with only a caret inside a highlight the same
shortcut instead moves keyboard focus to that highlight's card; Escape dismisses the
bar), **Prompt…** (`Ctrl+Alt+P`) and the quick chips (`Add proof`, `More rigorous`,
`Shorter`, `Cite`), and never takes focus or the selection. The copilot's buttons render
only with their handler in the card context (there is no feature flag any more), so a LaTeX-only
section, which the server cannot anchor, shows none.
**Keyboard-only commenting and prompting work from the Source view**: the Write view has
no caret, so there a keyboard user can read the cards but cannot start one (the header
Copilot button, which prompts about the whole section, works in both views).

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
narrow side sheet closing, the right pane being closed and opened again) and is restored on reopen, cleared
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
Resolved badges), `Quote` the quote area (default: the quoted text), `Body` everything
below. A review card puts severity/type pills in `Status` and the issue in `Body`; a
suggestion card its working / ready / failed state in `Status`, its diff in `Quote` and
its actions in `Body`; `ReadOnlyCardBody` is the fallback for a kind this client does not
know. `MarginCardContext` is `{ projectId, nodeId, currentUserId,
restoreEditorFocus, applyServerContent, hasUnsavedEdits, flushEdits, holdSaving,
sectionNumber, serverAnchor, editBlockedReason, revisable, rewriteBlock, knownIds, startRevision,
onSendToCopilot, onFixWithCopilot, onTryAgain, onCommentSent }`. `ComposerDraft` in `margin-store.ts` is a discriminated union
(`comment | prompt`; every kind carries `anchor`): the margin positions and highlights any
draft from `anchor` alone and renders it through `COMPOSER_KINDS`
(`margin/composer-registry.tsx`), so a new kind of draft is one union member and one entry.
The pinned items (the review strip, section-level and orphaned cards) are laid out like
cards by `layoutMargin`, so the cards beside the text are pushed down by them instead of
hiding under a header.

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

*Review cards (issue #164's design, built once here).* `margin/review-card.tsx`, filled from
the API's `kind=review` rows: `Status` is the severity pill (**Major**, destructive tint, warning
triangle; **Minor**, warning tint, circle: told apart by word and shape as well as colour) and the
type chip (`consistency:term` shows as *Consistency: term*), plus *Outdated* (a newer review no
longer reports it but replies keep it) and *Dismissed*. `Quote` is the anchored quote; `Body` the
description, a **Required fix** inset, the optional `replaceFrom` -> `replaceTo` chips (mono, struck
destructive tint to success tint; only when both halves are present), the provenance (*Reviewer*,
*Consistency check*, *Citation check*) and the shared thread controls: **Reply** (the API allows
replies under a review root), **Fix with Copilot** and **Dismiss** (the resolve endpoint; a dismissed
issue shows with *Show resolved* and offers *Reopen*; an issue the user resolved or deleted is not
re-created by a later import). The card's accessible name is the issue itself (`Review issue, major
Coverage: ...`), since reviewer cards have no author.

`margin/review-summary-strip.tsx` is the section verdict from `OutlineNode.reviewSummary`
(`okToKeep`, `issueCount`, `suggestedEdits`, `retrievalQueries`, `reviewedAt`): a compact **fixed
header above the card lane** (the cards scroll, it does not), shown with the **All** and **Review**
filters: the pill (*Needs revision* / *OK to keep*; `okToKeep` with `issueCount` 0 says *No issues
found*), `N major · M minor` counted over the *open* review cards (a dismissed one is not counted),
when it was reviewed, the reviewer score if a run produced one (`reviewerScore`, never yet; it used
to be the Review tab's badge) and two links, *Suggested edits (N)* and *Searches that would find
missing evidence (N)*, that open a scrollable panel over the cards (one at a time; Escape closes it).
The header sits above the lane, so the lane starts lower than the text pane: `MarginPanel` measures
that offset and keeps cards clear of it (`layoutMargin`'s `minTop`). A section reviewed before review
rows existed (no `reviewSummary`, no review cards, but a non-empty `reviewerNotes`) shows those old
notes as a plain *Review notes (previous run)* panel in the same header; once cards exist the notes
are never read. #164's collapse/expand-per-card design is **superseded** by the margin layout: a card
is always open, and a description or required fix longer than a few lines is clamped with *Show more*,
so one issue cannot take the whole lane. Cards with no anchor stack at the top, majors first, then
oldest, then by id; an unknown or missing severity reads as Minor, the server's default.

*The prompt window (`margin/prompt-window.tsx`).* One window, three entry points, one result (a
suggestion card): the selection toolbar's **Prompt…** (scope locked to the range; the quick chips skip
the window and send at once, range scope, that one parameter), the **Copilot icon in the editor
header** (scope = the whole section) and **Try again** on a suggestion (prefilled from its
`instruction` and `params`). It is a card in the margin at the selection (a `prompt` member of
`ComposerDraft`): a scope pill (*Selection · N sentences* / *Section §x.y*), the instruction box,
the parameter chips as typed fields (`more proofs`, `more examples`, `more rigorous`, `shorter` /
`longer` (mutually exclusive), `cite sources`, `fix N issues` = the open review cards in scope as
`fixIssueIds`, `address N comments` = the open comment threads in scope as `addressCommentIds`;
a chip with nothing behind it is disabled; scope for a selection is what overlaps the range) and two
verbs: **Revise** (default) and **Rewrite**, available for the whole section only, with nothing
else set and not from a thread (the API 422s those, so the toggle refuses with the reason, shown as
text under the toggle, not only as a tooltip). Whether a Rewrite can start at all is worked out up
front, as the old copilot panel did, from the section and the run lane: not a leaf, content-locked,
no `cliKey`, no resumable run, a regenerate already queued, a run busy; each with its old wording and
way out (*Start full run*, *Unlock content*). A Rewrite replaces the section through a run, so sending
it asks first (*Rewrite this section?*), and a refusal the API still makes is mapped to words (known
reasons) or a generic line; a raw server string, ids included, is never shown. For a LaTeX-only
section Revise is unavailable (with the reason) and the window opens locked to Rewrite. "Regenerate
again" on a run page opens the section with the window on Rewrite, filled in with that run's
instruction (`?copilot=rewrite&instruction=`, consumed once).
`Ctrl+Enter` sends from anywhere in the window, `Escape` closes it (and forgets its text); focus
goes into the box when it opens and back to the Copilot button (or the text) when it closes. Unsent
text lives in `useMarginStore.drafts` and the options and verb in `promptExtras`, one pair per
scope (`prompt:section`, or `prompt:range:<start>-<end>`): opening a window never deletes another
scope's draft, reopening the same scope restores both, and an unfinished prompt (or a comment with
text) is saved per section when the section is left and restored when it is opened again. A press on
the editor that closes the narrow side sheet therefore loses nothing. Refusals are shown **inline**, in words, never as a
status code: `section_empty`, `node_generating`, `anchor_orphaned`, `revision_in_progress`,
`llm_key_required` (with an *Account settings* shortcut), `llm_not_configured`, `too_many_revisions`,
`section_too_large` (suggests selecting a passage); a Rewrite's refusals (no previous run, locked
node, queue full) are shown as the API sent them. Starting a revision first awaits
`ctx.flushEdits()` (the server revises the *saved* text). A Rewrite that started toasts that it
became a run, with a *View run* action, and the run is followed by its id (`trackRun`) so a short run
that starts and ends between two polls of the run list still refreshes the outline and toasts its
outcome. A comment (or reply, or an edit that adds the mention) that mentions `@copilot` is a prompt:
the mention must be plain text (not in code, not in a quoted line, not `@copilot.com`); the composer's
button then reads *Comment and ask Copilot*; the comment is created first, then a revision with
`threadId` is started and the suggestion arrives inside that thread; `Send to Copilot` on a thread and `Fix with Copilot` on a review card do the same
without typing (the review card sends `fixIssueIds: [id]`, with the card's range when it has one,
else section scope). `margin/use-copilot.ts` holds all of these; everything it returns is
referentially stable (handlers read the latest values through a ref), because the card context is
built from it and a context that changed per keystroke re-rendered every card on every keystroke.
Anchors sent to the server go through `lib/server-anchor.ts`: never an empty quote (a 422), offsets
only when they match the quote's code-point length, and no offsets at all for a section the server
stores with CR LF (the editor counts LF; the server then finds the quote itself). A request carries at
most 25 ids per list (24 with a `threadId`, which the server adds to one of them), and the chip's label
counts what is sent. One start at a time per section entry (chips, Send/Fix with Copilot).

*Suggestions (`margin/suggestion-card.tsx`, `suggestion-diff.tsx`, `lib/diff-view.ts`).* Every state
of the API's `kind=suggestion` row has its card: **running** (working pill with the elapsed time,
the instruction, a Retrieve / Revise / Compare step list and the live stage line from the progress
events, a polite live region announcing the change, **Cancel** for its author only), **pending**
(the diff, the model's summary, `changesMade`, `warnings` and `droppedCitations`, **Accept**,
**Reject**, **Try again** with *Edit the instruction…* / *Ask again as it was*), **failed** and
**cancelled** (the `error.code` in words, **Try again**, **Dismiss** = delete; they stay in the margin
until dismissed) and **accepted** / **rejected** (compact, hidden with the resolved ones by default). A
suggestion that arrived in a comment thread renders as a block inside that thread's card with the
same parts. The diff is built by hand from `payload.hunks` over `originalMarkdown`: removed text on a
destructive tint with a strike-through and "Removed:" for screen readers, added text on a success
tint, underlined, "Added:", each with a little unchanged text around it (context stops where the next
hunk's changed text begins; for a range suggestion it never leaves the range, so the card shows the
range's before/after). Hunk offsets are **Unicode code points** into `originalMarkdown`: every
offset goes through `CodePointIndex` before slicing, context is never cut inside a surrogate pair, and
a CR LF original is shown with LF. Only the first three changes show until *Show all N changes*; a
very long change is clamped until asked for. A section suggestion with several changes has a checkbox
per change (the selected ones go as `hunkIndexes`, *Accept 2 of 3*; the card notes that a partial accept
leaves the linked comments and issues open, as the API does). A pending suggestion whose own range
(the row's anchor, re-anchored with the text; `payload.anchor` is the range in the original, which
clips the diff) is gone says "The text changed since this was suggested" and still offers Accept; a section
suggestion made against an older text than the section now has says it may be refused. A model
that handed the text back unchanged shows "nothing to change" with no Accept. A finished suggestion
from the node list has no `originalMarkdown` but keeps its hunks: its card shows the removed and added
text without context (only the applied changes after a partial accept). Dismiss is offered only to
the person who may delete the row (its author, or anyone for a row nobody authored); a cancelled
suggestion says "You stopped this revision" only when `payload.cancelledBy` is the signed-in user.
Try again on a range suggestion whose range is gone opens the window (which says the scope is now the
section) instead of silently widening it, and "Ask again as it was" drops references to cards that
were deleted since. The suggestion's
range is highlighted in both views in the suggestion style and focusing the card focuses it.
Progress: `margin/suggestion-progress.ts`'s `useSuggestionStreams` (mounted by the open section, not
by the cards, so a filter or the side sheet cannot lose it) follows every running suggestion by id
- also after a reload - and on the terminal event writes the finished suggestion into the caches
and the outline row's `pendingSuggestionCount` badge; the badge moves on start, accept, reject, cancel
and failure without a reload.

*Accept (the data-loss-sensitive part, `margin/use-suggestion-actions.ts`).* The order is fixed:
`ctx.holdSaving()` awaits `flushEdits()` (the server accepts against the saved text) and then holds
autosave; the accept is posted with `expectedContentHash` (and `hunkIndexes` if partial); on success the
returned node replaces the section's cache entries and `ctx.applyServerContent(text, hash)` hands the
editor the new text: adopted at once (kept out of the undo history, via the `ExternalChange` path) when
nothing is unsaved; otherwise the draft stays exactly as typed, the "changed elsewhere" notice (Keep
mine / Load the other version) is set **synchronously** and autosave stays held, and the hold's release
does **not** flush, so text typed while the POST was in flight can never be saved over the accepted
text. The hold is released in a `finally`; on any failure the draft is untouched, and `stale` and
`content_conflict` (the section is also fetched again) are explained inline on the card, not toasted.
A second click (also during the save before the POST) is ignored and the buttons are disabled for the
whole action. While the notice is up, or after a failed save (`flushEdits` keeps rejecting while the
failed value is pending), Accept, Try again, Undo and a new revision are refused with the reason shown.
Node fetches in flight when an accept or undo starts are cancelled, so a stale answer cannot restore
the old text and hash afterwards. `Ctrl+Z` right after an accept does nothing useful (the adopted text
is not in the editor's history, by design), so a toast, *Suggestion applied · Undo*, offers the way
back: the same hold and adoption, a PATCH of the previous text guarded by the hash the accept returned
(refused, with a message, if the section was edited since), and for a full accept the comment threads
and review issues that accept had resolved are reopened. It says **Text restored**; the suggestion
stays *accepted* on the server (an undo is an ordinary content write), and this tab marks its card
*Accepted, then undone* until a reload.

*Content hash everywhere.* The server treats a content PATCH without `expectedContentHash` as
last-write-wins, so **every autosave** sends it: the hash of the text **the draft was based on**
(`baseHashRef`, kept beside the baseline text and moved only when the baseline itself moves: an
adoption, this editor's own successful save with the hash the server returned, Keep mine), never
whatever the node cache holds when the save runs; a save made on top of text the user has not seen
(an accept that landed meanwhile) is therefore refused as a conflict instead of passing with the newer
text's hash. The hash is the server's `contentHash` (the list rows carry none), hashing the baseline
text (`lib/content-hash.ts`) only where a response had none. A `409 content_conflict` is never retried over: the section is fetched again and
the existing "changed elsewhere" notice takes over (*Keep mine* saves the draft over the other
version, now based on its hash; *Load the other version* replaces the draft). Autosave holds are kept
per reason (`useDebouncedMutation.hold(held, reason)`), so an accept in flight and a pending
notice cannot lift each other's hold, and a content GET that began before a save is cancelled so
it cannot put the old text and hash back.

*The legacy drawer is gone.* Removed: `CopilotDrawer`, `CopilotPanel`, the Review tab
(`ReviewPanel`), `SectionSourcesCard` (its job lives in Chapter options and the sources drawer),
the Margin | Copilot switch, the `tab` search parameter (an old `?tab=review` link is dropped from the search state and from the
address bar), `ui-store.rightPane` and the aria names that mentioned the
copilot (`copilotOpen` / `toggleCopilot` / `copilotPane` became `marginOpen` / `toggleMargin` /
`marginPane`; the persisted store is migrated: `copilotOpen` -> `marginOpen`, `rightPane` dropped).
What lived only in the drawer and where it is now: regenerate with an instruction -> *Rewrite* in the
prompt window (with the API's 409 reasons inline); quick-action presets -> the chips; the event log
and the status footer -> the run page, which shows them and the cost; the stage timeline was
**removed with the drawer** (a real run's `RunEvent.stage` values are stdout log tags, not pipeline
stages, so a summary of them says nothing, and the runs page is out of scope for this issue; the run
page's event log still shows every event with its tag); the node's source scope -> Chapter options and the sources drawer;
the content-locked hint -> the header lock button. There is no run tray in the studio: run status
stays on the runs page and in the row spinners, and a running revision is the running state of its
own card.

*Editor setup and the bundle.* The build aliases `@uiw/codemirror-extensions-basic-setup` to
`lib/editor-setup.ts` (`vite.config.ts`), a copy of its extension list without the autocompletion
popup and the lint keymap, which a Markdown source editor never uses and which kept 22 kB gzipped
(the completion machinery of `@codemirror/autocomplete`, of which only `closeBrackets` is kept, and
`@codemirror/lint`) in the
bundle. Line numbers, undo history, the default, search (the `Ctrl+F` panel), history, fold and
close-brackets keymaps, bracket matching and closing, selection drawing, rectangular selection and
the match/active-line highlights are unchanged. `@codemirror/commands`, `search` and `autocomplete`
(already installed as peers of `@uiw/react-codemirror`) are now declared as direct dependencies
because that file imports them. The alias is applied in the build, the dev server and the tests
(`test.server.deps.inline` runs `@uiw/react-codemirror` through Vite); `lib/editor-setup.test.tsx`
checks that the upstream import name resolves to the trimmed copy and pins search, undo/redo, bracket
closing and Tab indentation; and `scripts/check-bundle-budget.mjs` fails if
`codemirror-extensions-basic-setup` or `@codemirror/lint` appear in the bundle, so an upstream rename
or a config change cannot bring them back silently.

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
| Route search params (`routes/p.$projectId.tsx`'s `ProjectSearch`) | Shareable/URL state. | The selected outline node (`?node=`) — refreshing or sharing the URL preserves it. |
| `src/stores/ui-store.ts` (Zustand) | Client-only UI state that isn't server data or shareable. | Outline/margin pane visibility and width (`outlineOpen`, `marginOpen`, `outlineWidth`), which modal (if any) is open. Pane visibility/width persist to `localStorage`; the open modal always resets to closed on reload. |

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

**Suggestion streaming.** A revision (issue #182 phase 4) has its own stream,
`subscribeSuggestionEvents` in the same file: `GET /suggestions/{id}/events/stream`
(`progress` events, then one terminal `done` / `failed` / `cancelled`). The browser's own
`EventSource` reconnects with `Last-Event-ID` after an error (events already seen are dropped by
`seq`); after two errors in a row, or a connection the browser gave up on, the stream is abandoned
and the suggestion row is polled (`GET /comments/{id}`) until it leaves `running`, so a proxy that
kills event streams only costs the live stage line. The stream is read-only (the progress events are
persisted by the API, so any replica serves it); the terminal event carries the finished suggestion.

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
