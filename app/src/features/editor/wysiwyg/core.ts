import { EditorState, type Plugin, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

import type { TextChange } from '@/features/editor/lib/anchors';

import { parseDocument } from './parse';
import { SourceModel } from './source-model';

/**
 * The editor state and the source model kept in step (issue #182, phase 5). Every transaction goes
 * through `apply`: it is applied to the editor state, the source model rewrites the blocks it
 * changed, and the transaction is accepted only when that worked. A refused transaction leaves both
 * untouched. Free of the DOM, so tests drive it directly and the React component only forwards.
 */
export interface Applied {
  ok: true;
  state: EditorState;
  /** The new source, and what changed in it (`null`: nothing in the source). */
  text: string;
  change: TextChange | null;
  docChanged: boolean;
}
export interface Refused {
  ok: false;
}

export class EditorCore {
  state: EditorState;
  model: SourceModel;
  private readonly plugins: readonly Plugin[];

  constructor(text: string, plugins: readonly Plugin[] = []) {
    this.plugins = plugins;
    const parsed = parseDocument(text);
    this.model = new SourceModel(text, parsed);
    this.state = EditorState.create({ doc: parsed.doc, plugins: [...plugins] });
  }

  get text() {
    return this.model.text;
  }

  get doc(): PMNode {
    return this.state.doc;
  }

  /** Replaces everything with `text` (server content): fresh state, so nothing of it enters the undo history. */
  reset(text: string): EditorState {
    const parsed = parseDocument(text);
    this.model = new SourceModel(text, parsed);
    this.state = EditorState.create({ doc: parsed.doc, plugins: [...this.plugins] });
    return this.state;
  }

  apply(tr: Transaction): Applied | Refused {
    const next = this.state.apply(tr);
    if (next.doc === this.state.doc) {
      this.state = next;
      return { ok: true, state: next, text: this.model.text, change: null, docChanged: false };
    }
    const result = this.model.update(next.doc);
    if (!result.ok) return { ok: false };
    this.state = next;
    return { ok: true, state: next, text: result.text, change: result.change, docChanged: true };
  }
}
