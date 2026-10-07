/**
 * The copilot's entry points in the margin workspace (issue #182 phase 4): the selection toolbar's
 * `Prompt…` and quick chips, and `Send to Copilot` on a thread. Off until the revise endpoint and
 * the prompt window exist, so no dead buttons ship. Flip this one constant (it is passed down as
 * the `copilotActions` prop) when phase 4 wires them.
 */
export const COPILOT_ACTIONS_ENABLED = false;
