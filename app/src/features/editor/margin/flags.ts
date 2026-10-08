/**
 * The copilot's entry points in the margin workspace (issue #182 phase 4): the selection toolbar's
 * `Prompt…` and quick chips, `Send to Copilot` on a thread and `Fix with Copilot` on a review card.
 * On since the revise endpoint, the prompt window and the suggestion cards exist; each button also
 * needs its handler in the card context, so a section that cannot be revised (LaTeX) shows none.
 */
export const COPILOT_ACTIONS_ENABLED = true;
