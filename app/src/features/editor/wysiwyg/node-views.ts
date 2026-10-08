import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';

import type { RagCitation } from '@/features/editor/lib/rag-citation';
import { resolveImageSrc } from '@/features/editor/lib/resolve-image-src';

/**
 * Atoms: what the editable Write view cannot represent faithfully is shown with the read-only
 * view's own renderers, cannot be typed into, and carries its exact source (issue #182, phase 5).
 * Inline atoms are plain DOM (KaTeX, citation chips, images); block atoms are rendered by React
 * (`MarkdownView` of their source, through `AtomPortals`) into a container this module owns.
 *
 * Atoms are *selectable*, not focusable: a selected atom (arrow keys, a click) opens in the
 * Source view with Enter or a double click, and the visible "Edit in Source" label does the same
 * on a click. Nothing inside the editable region is a tab stop, so keyboard users are never trapped
 * and the region stays one labelled textbox.
 */

export interface BlockAtomRecord {
  /** Stable for the life of the atom: the React key of its portal. */
  id: number;
  source: string;
  kind: string;
  label: string;
}

export class AtomHost {
  private readonly blocks = new Map<HTMLElement, BlockAtomRecord>();
  private readonly chips = new Map<HTMLElement, string[]>();
  private version = 0;
  private nextId = 0;
  private readonly listeners = new Set<() => void>();
  citations = new Map<string, RagCitation>();
  onCitationClick: ((key: string) => void) | undefined;
  /** Opens the Source view on the atom at editor position `pos`. */
  onEditInSource: ((pos: number) => void) | undefined;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.version;

  private bump() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  blockEntries(): [HTMLElement, BlockAtomRecord][] {
    return [...this.blocks];
  }

  setBlock(target: HTMLElement, record: Omit<BlockAtomRecord, 'id'>) {
    const previous = this.blocks.get(target);
    if (previous && previous.source === record.source && previous.kind === record.kind) return;
    this.blocks.set(target, { ...record, id: previous?.id ?? this.nextId++ });
    this.bump();
  }

  removeBlock(target: HTMLElement) {
    if (this.blocks.delete(target)) this.bump();
  }

  /** A new citation list: chips are re-labelled in place. */
  setCitations(citations: Map<string, RagCitation>) {
    this.citations = citations;
    for (const [el, keys] of this.chips) fillChips(el, keys, this);
  }

  registerChips(el: HTMLElement, keys: string[]) {
    this.chips.set(el, keys);
  }

  unregisterChips(el: HTMLElement) {
    this.chips.delete(el);
  }
}

const CHIP_CLASS =
  'not-prose mx-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 align-baseline text-[11px] font-medium whitespace-nowrap';
const CHIP_RESOLVED =
  'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer';
const CHIP_UNRESOLVED =
  'cursor-default border-dashed border-muted-foreground/40 text-muted-foreground';

function fillChips(container: HTMLElement, keys: string[], host: AtomHost) {
  container.textContent = '';
  for (const key of keys) {
    const citation = host.citations.get(key);
    const chip = document.createElement('span');
    chip.className = `${CHIP_CLASS} ${citation ? CHIP_RESOLVED : CHIP_UNRESOLVED}`;
    chip.setAttribute('data-testid', `citation-chip-${key}`);
    chip.setAttribute('data-citekey', key);
    chip.title =
      citation?.sectionSnippet ?? `Citation "${key}" not found in this section's sources`;
    chip.textContent = citation?.authorYear ?? citation?.sourceDoc ?? key;
    container.append(chip);
  }
}

function describe(kind: string, label: string): string {
  switch (kind) {
    case 'math':
      return `Formula: ${label}`;
    case 'citation':
      return `Citation: ${label}`;
    case 'image':
      return `Image: ${label || 'no description'}`;
    case 'footnote':
      return `Footnote reference ${label}`;
    case 'html':
      return 'HTML';
    case 'callout':
      return `Callout: ${label}`;
    case 'table':
      return 'Table';
    case 'rule':
      return 'Horizontal rule';
    default:
      return label || 'Markdown that this view cannot edit';
  }
}

const HINT = 'Edit in Source';

class AtomInlineView implements NodeView {
  dom: HTMLElement;
  private math: HTMLElement | null = null;
  private node: PMNode;
  private readonly host: AtomHost;
  private readonly getPos: () => number | undefined;

  constructor(node: PMNode, getPos: () => number | undefined, host: AtomHost) {
    this.node = node;
    this.getPos = getPos;
    this.host = host;
    this.dom = document.createElement('span');
    this.dom.setAttribute('data-md-atom-inline', '');
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.edit();
    });
    this.dom.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-citekey]');
      const key = chip?.getAttribute('data-citekey');
      if (key && this.host.citations.has(key)) this.host.onCitationClick?.(key);
    });
    this.render();
  }

  private edit() {
    const pos = this.getPos();
    if (pos !== undefined) this.host.onEditInSource?.(pos);
  }

  private render() {
    const { dom } = this;
    const kind = this.node.attrs['kind'] as string;
    const label = this.node.attrs['label'] as string;
    const source = this.node.attrs['source'] as string;
    this.host.unregisterChips(dom);
    if (this.math) this.host.removeBlock(this.math);
    this.math = null;
    dom.textContent = '';
    dom.setAttribute('data-md-kind', kind);
    dom.setAttribute('role', 'img');
    dom.setAttribute('aria-label', `${describe(kind, label)}. Press Enter to edit in Source.`);
    dom.title = HINT;
    dom.className = `md-atom-inline md-atom-${kind}`;
    switch (kind) {
      case 'math': {
        // Rendered by React (the read-only view's own pipeline, through `AtomPortals`).
        const body = document.createElement('span');
        dom.append(body);
        this.math = body;
        this.host.setBlock(body, { source, kind: 'inline-math', label });
        break;
      }
      case 'citation': {
        const keys = label.split(', ').filter(Boolean);
        fillChips(dom, keys, this.host);
        this.host.registerChips(dom, keys);
        break;
      }
      case 'image': {
        const src = /\(\s*<?([^)\s>]+)/.exec(source)?.[1] ?? '';
        const img = document.createElement('img');
        img.src = resolveImageSrc(src);
        img.alt = label;
        img.className = 'my-1 inline-block max-w-full rounded-md border align-bottom';
        dom.append(img);
        break;
      }
      case 'footnote': {
        const sup = document.createElement('sup');
        sup.textContent = `[${label}]`;
        dom.append(sup);
        break;
      }
      case 'link':
        dom.textContent = label.replace(/^<|>$/g, '');
        dom.classList.add('text-primary', 'underline', 'underline-offset-2');
        break;
      default:
        dom.textContent = kind === 'html' ? source : label || source;
        dom.classList.add('font-mono', 'text-[0.85em]', 'text-muted-foreground');
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed =
      node.attrs['source'] !== this.node.attrs['source'] ||
      node.attrs['kind'] !== this.node.attrs['kind'] ||
      node.attrs['label'] !== this.node.attrs['label'];
    this.node = node;
    if (changed) this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.type === 'dblclick';
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.host.unregisterChips(this.dom);
    if (this.math) this.host.removeBlock(this.math);
  }
}

class AtomBlockView implements NodeView {
  dom: HTMLElement;
  private readonly body: HTMLElement;
  private node: PMNode;
  private readonly host: AtomHost;
  private readonly getPos: () => number | undefined;

  constructor(node: PMNode, getPos: () => number | undefined, host: AtomHost) {
    this.node = node;
    this.getPos = getPos;
    this.host = host;
    this.dom = document.createElement('div');
    this.dom.setAttribute('data-md-atom-block', '');
    this.dom.contentEditable = 'false';
    this.dom.className = 'md-atom-block';
    this.body = document.createElement('div');
    this.body.className = 'md-atom-body';
    const hint = document.createElement('span');
    hint.className = 'md-atom-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.setAttribute('data-md-edit', '');
    hint.textContent = HINT;
    this.dom.append(this.body, hint);
    this.dom.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.edit();
    });
    hint.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.edit();
    });
    this.sync();
  }

  private edit() {
    const pos = this.getPos();
    if (pos !== undefined) this.host.onEditInSource?.(pos);
  }

  private sync() {
    const kind = this.node.attrs['kind'] as string;
    const label = this.node.attrs['label'] as string;
    this.dom.setAttribute('data-md-kind', kind);
    this.dom.setAttribute('role', 'group');
    this.dom.setAttribute(
      'aria-label',
      `${describe(kind, kind === 'math' ? 'display formula' : label)}. Press Enter to edit in Source.`,
    );
    const source = this.node.attrs['source'] as string;
    if (kind === 'footnote' || kind === 'definition' || kind === 'html') {
      // The read-only view draws nothing for these (definitions, footnote texts, HTML it will not
      // render): here they would be invisible and impossible to find, so their source is shown.
      this.host.removeBlock(this.body);
      this.body.textContent = source;
      this.body.className = 'md-atom-body md-atom-source';
    } else {
      this.host.setBlock(this.body, { source, kind, label });
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event): boolean {
    return (
      event.type === 'dblclick' ||
      (event.type === 'click' && (event.target as HTMLElement).hasAttribute('data-md-edit'))
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.host.removeBlock(this.body);
  }
}

export function nodeViews(host: AtomHost) {
  return {
    atom_inline: (node: PMNode, _view: EditorView, getPos: () => number | undefined) =>
      new AtomInlineView(node, getPos, host),
    atom_block: (node: PMNode, _view: EditorView, getPos: () => number | undefined) =>
      new AtomBlockView(node, getPos, host),
  };
}
