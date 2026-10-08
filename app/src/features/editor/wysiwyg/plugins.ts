import {
  chainCommands,
  createParagraphNear,
  deleteSelection,
  exitCode,
  joinBackward,
  joinForward,
  liftEmptyBlock,
  newlineInCode,
  selectAll,
  selectNodeBackward,
  selectNodeForward,
  splitBlock,
  toggleMark,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node as PMNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  type Command,
  type EditorState,
} from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { schema } from './schema';

/**
 * Behaviour of the editable Write view: key bindings, Markdown input rules, history and the
 * small plugins that keep the document usable (a place to type after the last block, a Tab that
 * never traps keyboard users, a placeholder). Everything here edits the *editor document*; the
 * source follows through `SourceModel.update`, which is what keeps untouched Markdown intact.
 */

const { nodes, marks } = schema;

export interface EditorCallbacks {
  /** Ctrl/Cmd-S: save now. */
  onFlush: () => void;
  /** Enter on a selected atom: open the Source view on `[from, to)` of the draft (UTF-16 offsets). */
  onEditInSource: (pos: number) => void;
  /** Ctrl/Cmd-K: ask for the link target; resolves to `null` when cancelled. */
  requestLink: (current: string | null) => Promise<string | null> | string | null;
}

// ---- Tab: indents in lists, and never traps the keyboard ---------------------------------

const tabKey = new PluginKey<{ free: boolean }>('mdTabEscape');

/**
 * `Escape` lets the next `Tab` through to the browser (focus moves on) even inside a list, where
 * `Tab` otherwise indents - the same escape hatch the Source view has.
 */
const tabEscape = new Plugin<{ free: boolean }>({
  key: tabKey,
  state: {
    init: () => ({ free: false }),
    apply: (tr, value) => {
      const meta = tr.getMeta(tabKey) as boolean | undefined;
      return meta === undefined ? value : { free: meta };
    },
  },
  props: {
    handleKeyDown(view, event) {
      const free = tabKey.getState(view.state)?.free ?? false;
      if (event.key === 'Escape') {
        view.dispatch(view.state.tr.setMeta(tabKey, true));
        return false;
      }
      if (event.key !== 'Tab' && free && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
        view.dispatch(view.state.tr.setMeta(tabKey, false));
      }
      return false;
    },
  },
});

const inList = (state: EditorState) => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === nodes['list_item']) return true;
  }
  return false;
};

const tabCommand =
  (inner: Command): Command =>
  (state, dispatch, view) => {
    if (tabKey.getState(state)?.free) return false;
    if (!inList(state)) return false;
    // In a list the key always belongs to the editor (a no-op at the first item, rather than a jump).
    inner(state, dispatch, view);
    return true;
  };

// ---- marks and links ----------------------------------------------------------------------

/** The range of the link mark around `pos`, or null. */
function linkRangeAt(doc: PMNode, pos: number): { from: number; to: number; href: string } | null {
  const link = marks['link']!;
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  const start = $pos.start();
  let found: { from: number; to: number; href: string } | null = null;
  parent.forEach((child, offset) => {
    const mark = child.marks.find((m) => m.type === link);
    const from = start + offset;
    const to = from + child.nodeSize;
    if (mark && pos >= from && pos <= to) {
      const joined = found && found.to === from && found.href === mark.attrs['href'];
      found = joined
        ? { from: found!.from, to, href: found!.href }
        : { from, to, href: mark.attrs['href'] as string };
    }
  });
  return found;
}

/** Ctrl/Cmd-K: set, change or remove (empty target) the link on the selection or on the link around the caret. */
function linkCommand(callbacks: EditorCallbacks): Command {
  return (state, dispatch, view) => {
    const link = marks['link']!;
    let { from, to } = state.selection;
    const around = linkRangeAt(state.doc, from);
    if (state.selection.empty) {
      if (!around) return true;
      ({ from, to } = around);
    }
    if (!dispatch || !view) return true;
    const doc = state.doc;
    const current = around?.href ?? null;
    void Promise.resolve(callbacks.requestLink(current)).then((href) => {
      if (href === null || view.isDestroyed || view.state.doc !== doc) return;
      const tr = view.state.tr.removeMark(from, to, link);
      if (href.trim() !== '') tr.addMark(from, to, link.create({ href: href.trim(), title: '' }));
      view.dispatch(tr);
      view.focus();
    });
    return true;
  };
}

/**
 * `**bold**`, `*em*`, `_em_`, `~~strike~~` and `` `code` `` typed out become marks. The regexp's
 * first group is the character before the opening delimiter (kept), the second the text.
 */
function markRule(regexp: RegExp, type: MarkType): InputRule {
  return new InputRule(
    regexp,
    (state, match, start, end) => {
      const lead = match[1] ?? '';
      const inner = match[2];
      if (!inner || /^\s|\s$/.test(inner)) return null;
      // `start..end` is what is in the document of the match (the closing delimiter's last
      // character is still being typed); all of it but the text itself goes.
      const tr = state.tr.replaceWith(
        start + lead.length,
        end,
        schema.text(inner, [type.create()]),
      );
      return tr.removeStoredMark(type);
    },
    { inCodeMark: false },
  );
}

const NOT_ATOM = '\\ufffc';

function inputRulesPlugin(): Plugin {
  const heading = textblockTypeInputRule(/^(#{1,6})\s$/, nodes['heading']!, (match) => ({
    level: match[1]!.length,
  }));
  const bullet = wrappingInputRule(/^\s*([-+*])\s$/, nodes['bullet_list']!, (match) => ({
    marker: match[1]!,
    tight: true,
  }));
  const ordered = wrappingInputRule(
    /^(\d{1,9})([.)])\s$/,
    nodes['ordered_list']!,
    (match) => ({ start: Number(match[1]), delim: match[2]!, step: 1, tight: true }),
    (match, node) => node.childCount + (node.attrs['start'] as number) === Number(match[1]),
  );
  const quote = wrappingInputRule(/^\s*>\s$/, nodes['blockquote']!);
  const code = textblockTypeInputRule(/^```([\w-]*)\s$/, nodes['code_block']!, (match) => ({
    info: match[1] ?? '',
    fence: '`',
  }));
  return inputRules({
    rules: [
      heading,
      bullet,
      ordered,
      quote,
      code,
      // **bold**, ~~strike~~, `code`, *em*, _em_ - the closing delimiter completes the rule.
      markRule(new RegExp(`(^|[^*])\\*\\*([^*${NOT_ATOM}]+)\\*\\*$`), marks['strong']!),
      markRule(new RegExp(`(^|[^~])~~([^~${NOT_ATOM}]+)~~$`), marks['strike']!),
      markRule(new RegExp(`(^|[^\`])\`([^\`${NOT_ATOM}]+)\`$`), marks['code']!),
      markRule(new RegExp(`(^|[^*])\\*([^*${NOT_ATOM}]+)\\*$`), marks['em']!),
      markRule(new RegExp(`(^|[^_\\w])_([^_${NOT_ATOM}]+)_$`), marks['em']!),
    ],
  });
}

// ---- a place to type after the last block ---------------------------------------------------

const trailingParagraph = new Plugin({
  appendTransaction(trs, _old, state) {
    const last = state.doc.lastChild;
    const first = state.doc.firstChild;
    const needEnd = !last || last.type !== nodes['paragraph'];
    const needStart = first?.type === nodes['atom_block'];
    if (!needEnd && !needStart) return null;
    // Not part of the draft (an empty paragraph has no source) and not worth an undo step.
    const tr = state.tr;
    if (needEnd) tr.insert(tr.doc.content.size, nodes['paragraph']!.create());
    if (needStart) tr.insert(0, nodes['paragraph']!.create());
    // An input rule that has just fired (a heading typed as `## `) can still be undone with
    // Backspace; this extra transaction must not make the rule's plugin forget it. Positions
    // before the document's end do not move.
    const rules = state.plugins.find((plugin) => plugin.spec['isInputRules']);
    const fired = rules ? trs.map((t) => t.getMeta(rules) as unknown).find(Boolean) : null;
    if (rules && fired && !needStart) tr.setMeta(rules, fired);
    return tr.setMeta('addToHistory', false);
  },
});

const placeholderKey = new PluginKey('mdPlaceholder');

function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        const { doc } = state;
        if (
          doc.childCount !== 1 ||
          doc.firstChild!.type !== nodes['paragraph'] ||
          doc.firstChild!.content.size > 0
        ) {
          return null;
        }
        return DecorationSet.create(doc, [
          Decoration.node(0, doc.firstChild!.nodeSize, {
            class: 'md-placeholder',
            'data-placeholder': text,
          }),
        ]);
      },
    },
  });
}

// ---- commands -------------------------------------------------------------------------------

/** Enter on a selected atom opens Source on it. */
function editAtomCommand(callbacks: EditorCallbacks): Command {
  return (state) => {
    const { selection } = state;
    if (!(selection instanceof NodeSelection)) return false;
    const type = selection.node.type.name;
    if (type !== 'atom_block' && type !== 'atom_inline') return false;
    callbacks.onEditInSource(selection.from);
    return true;
  };
}

const hardBreak: Command = (state, dispatch) => {
  const type = nodes['hard_break']!;
  if (state.selection.$from.parent.type.spec.code) return false;
  // A heading is one line: Shift+Enter there does nothing (it is not an error).
  if (state.selection.$from.parent.type === nodes['heading']) return true;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(type.create()).scrollIntoView());
  return true;
};

const wrapMarks = (type: MarkType): Command => toggleMark(type);

/** Code on a selection: the text in it. An atom is source that is read, not text to put in a code span. */
const toggleCode: Command = (state, dispatch) => {
  const code = marks['code']!;
  const { from, to, empty } = state.selection;
  if (empty) return toggleMark(code)(state, dispatch);
  if (dispatch) {
    const tr = state.tr;
    if (state.doc.rangeHasMark(from, to, code)) tr.removeMark(from, to, code);
    else {
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isText) {
          tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), code.create());
        }
      });
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

export function buildPlugins(callbacks: EditorCallbacks, placeholder: string): Plugin[] {
  const listItem = nodes['list_item']!;
  // (A selection between top-level blocks, which ProseMirror's own commands do not expect, does nothing.)
  const betweenBlocks: Command = (state) => state.selection.$from.depth === 0;
  const enter = chainCommands(
    editAtomCommand(callbacks),
    betweenBlocks,
    newlineInCode,
    splitListItem(listItem),
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );
  const backspace = chainCommands(undoInputRule, deleteSelection, joinBackward, selectNodeBackward);
  const del = chainCommands(deleteSelection, joinForward, selectNodeForward);
  return [
    inputRulesPlugin(),
    history(),
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Mod-Shift-z': redo,
      'Mod-b': wrapMarks(marks['strong']!),
      'Mod-i': wrapMarks(marks['em']!),
      'Mod-e': toggleCode,
      'Mod-k': linkCommand(callbacks),
      'Mod-s': () => {
        callbacks.onFlush();
        return true;
      },
      Tab: tabCommand(sinkListItem(listItem)),
      'Shift-Tab': tabCommand(liftListItem(listItem)),
      'Shift-Enter': hardBreak,
      Enter: enter,
      'Mod-Enter': exitCode,
      Backspace: backspace,
      'Mod-Backspace': backspace,
      Delete: del,
      'Mod-Delete': del,
      'Mod-a': selectAll,
    }),
    tabEscape,
    trailingParagraph,
    placeholderPlugin(placeholder),
  ];
}
